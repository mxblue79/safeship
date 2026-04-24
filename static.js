import fs from "node:fs";
import path from "node:path";

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build",
  ".vercel", "coverage", ".turbo", ".cache", "out"
]);

// -----------------------------
// 시크릿 패턴
// -----------------------------
const SECRET_PATTERNS = [
  {
    name: "Stripe secret key",
    regex: /sk_(live|test)_[A-Za-z0-9]{24,}/g,
    severity: "critical"
  },
  {
    name: "AWS Access Key",
    regex: /AKIA[0-9A-Z]{16}/g,
    severity: "critical"
  },
  {
    name: "Google API Key",
    regex: /AIza[0-9A-Za-z_-]{35}/g,
    severity: "high"
  },
  {
    name: "GitHub Personal Access Token",
    regex: /ghp_[A-Za-z0-9]{36}/g,
    severity: "critical"
  },
  {
    name: "OpenAI API Key",
    regex: /sk-[A-Za-z0-9]{20,}/g,
    severity: "high"
  },
  {
    name: "Generic secret assignment",
    regex: /(password|passwd|secret|api[_-]?key|private[_-]?key)\s*[:=]\s*["'][^"'\s]{12,}["']/gi,
    severity: "medium"
  },
];

// -----------------------------
// 위험 코드 패턴 (코드 파일 대상)
// -----------------------------
const CODE_PATTERNS = [
  {
    pattern: /dangerouslySetInnerHTML/,
    title: "XSS 위험: dangerouslySetInnerHTML 사용",
    severity: "high",
    hint: "DOMPurify 등으로 sanitize 후 사용"
  },
  {
    pattern: /NEXT_PUBLIC_\w*(SERVICE_ROLE|SECRET|PRIVATE_KEY|API_SECRET)/i,
    title: "NEXT_PUBLIC_ 에 시크릿 키 노출",
    severity: "critical",
    hint: "접두어 제거하고 서버 측에서만 사용"
  },
  {
    pattern: /origin:\s*["']\*["']/,
    title: "CORS 전체 허용 (*)",
    severity: "high",
    hint: "구체적인 도메인 화이트리스트로 변경"
  },
  {
    pattern: /req\.(query|body|params)\.(user_?id|userId|tenant_?id|tenantId|role|is_?admin)/i,
    title: "클라이언트에서 권한성 필드 수신",
    severity: "critical",
    hint: "user_id, tenant_id, role 등은 반드시 JWT claims에서 추출"
  },
  {
    pattern: /\.(insert|update)\s*\(\s*\{[^}]*\btenant_id\s*:/,
    title: "tenant_id를 클라이언트 입력으로 insert/update",
    severity: "critical",
    hint: "서버/RLS에서 강제 주입하도록 변경"
  },
  {
    pattern: /console\.log\([^)]*(?:token|password|secret|api[_-]?key)/i,
    title: "민감 정보를 console.log 에 출력",
    severity: "medium",
    hint: "로그에서 민감 정보 제거"
  },
  {
    pattern: /\b(isAdmin|is_admin|bypass(?:Auth)?|skip(?:Auth|Check)|DEBUG_MODE|ADMIN_MODE)\s*[:=]\s*true\b/,
    title: "관리자/인증 우회 플래그가 하드코딩으로 true",
    severity: "critical",
    hint: "테스트용 백도어가 배포에 남아있을 가능성. 환경변수로 분리하거나 제거"
  },
  {
    pattern: /\/\/\s*(TODO|FIXME|XXX|HACK).*(auth|admin|권한|인증|보안|security|password|token)/i,
    title: "보안 관련 TODO/FIXME 주석",
    severity: "medium",
    hint: "배포 전 해결 필요한 미완성 보안 코드일 가능성"
  },
  {
    pattern: /role\s*[:=]\s*["'](admin|superuser|root)["']/i,
    title: "역할이 admin/superuser로 하드코딩됨",
    severity: "high",
    hint: "사용자 역할은 DB/JWT에서 조회해야 함. 테스트 코드 잔존 의심"
  },
  {
    pattern: /\.env\.(NODE_ENV|NEXT_PUBLIC_ENV)\s*!==?\s*["']production["']/,
    title: "production이 아닐 때만 실행되는 보안 우회 로직 의심",
    severity: "medium",
    hint: "if (NODE_ENV !== 'production') 블록에 인증/권한 우회가 있는지 확인"
  },
];

// Supabase 클라이언트 파일에서 service_role 사용
const SUPABASE_CLIENT_PATTERNS = [
  {
    pattern: /createClient\([^)]*SERVICE_ROLE/i,
    title: "클라이언트 측에서 Supabase service_role 키 사용 의심",
    severity: "critical",
    hint: "service_role 키는 서버 전용 (API Route, Edge Function, 백엔드)"
  },
];

// -----------------------------
// Webhook 서명 검증 누락
// -----------------------------
const WEBHOOK_FILE_PATTERN = /webhook/i;
const WEBHOOK_VERIFY_PATTERN = /signature|verify|hmac|stripe-signature|toss.?signature|x-webhook|crypto\.createHmac|timingSafeEqual/i;

// -----------------------------
// 유틸
// -----------------------------
function* walkFiles(dir) {
  if (!fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    // .env 는 통과, 나머지 hidden 은 건너뜀
    if (entry.name.startsWith(".") && !/^\.env/.test(entry.name) && entry.name !== ".gitignore") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else {
      yield full;
    }
  }
}

const isCodeFile = (f) => /\.(js|jsx|ts|tsx|mjs|cjs|go)$/.test(f);
const isSqlFile = (f) => /\.sql$/.test(f);
const isEnvFile = (f) => /(^|\/)\.env($|\.)/.test(f);
const isExampleFile = (f) => /\.(example|sample|template)$/.test(f);

function isClientFile(filePath) {
  // 서버 경로 제외
  const serverMarkers = [
    "/api/", "/server/", "/actions/",
    "route.ts", "route.js",
    "middleware.ts", "middleware.js",
    "/pages/api/"
  ];
  if (serverMarkers.some(m => filePath.includes(m))) return false;
  return /\/(components|app|pages|src|client|lib|hooks)\//.test(filePath);
}

function relPath(file, root) {
  return path.relative(root, file) || file;
}

// -----------------------------
// 검사 로직
// -----------------------------

function checkGitignore(rootDir, envFiles, issues) {
  const gitignorePath = path.join(rootDir, ".gitignore");
  let ignored = "";
  if (fs.existsSync(gitignorePath)) {
    ignored = fs.readFileSync(gitignorePath, "utf-8");
  }

  for (const envFile of envFiles) {
    if (isExampleFile(envFile)) continue;
    const rel = relPath(envFile, rootDir);
    // .gitignore에 .env 규칙이 있는지 느슨하게 확인
    if (!/^\s*\.env/m.test(ignored)) {
      issues.push({
        severity: "critical",
        title: ".env 파일이 .gitignore에 등재되지 않음",
        location: rel,
        hint: ".env, .env.local, .env.*.local 을 .gitignore에 추가. 이미 커밋됐으면 git rm --cached + BFG로 히스토리 제거"
      });
    }
  }
}

function checkEnvPublicLeaks(files, rootDir, issues) {
  // .env 파일에서 NEXT_PUBLIC_ 접두사가 붙은 민감 키를 탐지
  // Next.js 는 NEXT_PUBLIC_* 를 클라이언트 번들에 주입하므로,
  // 이 접두사에 민감 키가 붙는 것은 매우 위험함.
  const DANGER_SUFFIX = /NEXT_PUBLIC_\w*(SERVICE_ROLE|SECRET|PRIVATE[_-]?KEY|API[_-]?SECRET|DB[_-]?PASSWORD|STRIPE[_-]?SK|WEBHOOK[_-]?SECRET)/i;

  for (const file of files) {
    if (!isEnvFile(file)) continue;
    if (isExampleFile(file)) continue;
    let content;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (DANGER_SUFFIX.test(line)) {
        const keyName = (line.match(/^([A-Z_][A-Z0-9_]*)/) || [])[1] || "(unknown)";
        issues.push({
          severity: "critical",
          title: `NEXT_PUBLIC_ 접두사에 민감 키: ${keyName}`,
          location: `${relPath(file, rootDir)}:${i + 1}`,
          hint: "NEXT_PUBLIC_ 는 브라우저 번들에 포함됨. 접두사 제거 + 서버 전용 환경변수로 분리 + 키 즉시 재발급"
        });
      }
    }
  }
}

function checkSecrets(files, rootDir, issues) {
  for (const file of files) {
    if (isExampleFile(file)) continue;
    // 바이너리 파일 피하기
    if (!/\.(js|jsx|ts|tsx|mjs|cjs|go|sql|env|envrc|yaml|yml|json|md|txt|sh|toml)$/.test(file) &&
        !isEnvFile(file)) continue;

    let content;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    for (const { name, regex, severity } of SECRET_PATTERNS) {
      const matches = content.match(regex);
      if (matches && matches.length > 0) {
        // .env 자체에 키가 들어있는 건 정상, 단 gitignore 여부는 별도 체크
        const isInEnv = isEnvFile(file);
        issues.push({
          severity: isInEnv ? "medium" : severity,
          title: `시크릿 발견: ${name}${isInEnv ? " (.env 내부)" : " (소스 코드)"}`,
          location: relPath(file, rootDir),
          detail: `${matches.length}건`,
          hint: isInEnv
            ? ".env는 Git에 커밋되지 않아야 함. 이미 노출됐다면 키 재발급"
            : "환경변수로 분리 + Git 히스토리에서 제거 (BFG Repo-Cleaner)"
        });
      }
    }
  }
}

function checkCodePatterns(files, rootDir, issues) {
  for (const file of files) {
    if (!isCodeFile(file)) continue;
    let content;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    for (const check of CODE_PATTERNS) {
      if (check.pattern.test(content)) {
        issues.push({
          severity: check.severity,
          title: check.title,
          location: relPath(file, rootDir),
          hint: check.hint
        });
      }
    }

    if (isClientFile(file)) {
      for (const check of SUPABASE_CLIENT_PATTERNS) {
        if (check.pattern.test(content)) {
          issues.push({
            severity: check.severity,
            title: check.title,
            location: relPath(file, rootDir),
            hint: check.hint
          });
        }
      }
    }
  }
}

function checkWebhooks(files, rootDir, issues) {
  for (const file of files) {
    if (!isCodeFile(file)) continue;
    const rel = relPath(file, rootDir);
    if (!WEBHOOK_FILE_PATTERN.test(rel)) continue;

    const content = fs.readFileSync(file, "utf-8");
    if (!WEBHOOK_VERIFY_PATTERN.test(content)) {
      issues.push({
        severity: "critical",
        title: "Webhook 엔드포인트에 서명 검증 코드 없음",
        location: rel,
        hint: "PG사 시크릿으로 HMAC 검증 추가 (Stripe: stripe.webhooks.constructEvent, 토스: 서명 헤더 검증)"
      });
    }
  }
}

function checkSqlRls(files, rootDir, issues) {
  for (const file of files) {
    if (!isSqlFile(file)) continue;
    const content = fs.readFileSync(file, "utf-8");
    const rel = relPath(file, rootDir);

    const hasCreateTable = /create\s+table/i.test(content);
    const hasEnableRls = /enable\s+row\s+level\s+security/i.test(content);
    if (hasCreateTable && !hasEnableRls) {
      issues.push({
        severity: "high",
        title: "CREATE TABLE 있지만 RLS 활성화 구문 없음",
        location: rel,
        hint: "ALTER TABLE <name> ENABLE ROW LEVEL SECURITY; 추가"
      });
    }

    if (/using\s*\(\s*true\s*\)/i.test(content)) {
      issues.push({
        severity: "critical",
        title: "RLS USING (true) - 모든 사용자 허용 정책",
        location: rel,
        hint: "auth.uid() 또는 auth.jwt() 기반 실제 조건으로 변경"
      });
    }

    // CREATE POLICY ... FOR INSERT/UPDATE 에 WITH CHECK 누락 검사 (간이)
    const policyBlocks = content.match(/create\s+policy[\s\S]*?;/gi) || [];
    for (const block of policyBlocks) {
      const hasInsertOrUpdate = /for\s+(insert|update|all)/i.test(block);
      const hasWithCheck = /with\s+check/i.test(block);
      if (hasInsertOrUpdate && !hasWithCheck) {
        issues.push({
          severity: "high",
          title: "INSERT/UPDATE 정책에 WITH CHECK 절 누락",
          location: rel,
          detail: block.slice(0, 80).replace(/\s+/g, " ") + "...",
          hint: "WITH CHECK 없으면 tenant_id 등 변조 공격 가능"
        });
      }
    }
  }
}

function checkApiAuth(files, rootDir, issues) {
  const AUTH_KEYWORDS = /auth|jwt|session|getUser|getSession|requireUser|Authorization|authenticate|verifyToken/i;
  const PUBLIC_MARKER = /@public|\/\*\s*public\s*\*\//i;

  for (const file of files) {
    if (!isCodeFile(file)) continue;
    const rel = relPath(file, rootDir);
    const isApiRoute =
      /\/(api|route)\//.test(rel) ||
      rel.endsWith("route.ts") || rel.endsWith("route.js") ||
      /\/pages\/api\//.test(rel);
    if (!isApiRoute) continue;

    const content = fs.readFileSync(file, "utf-8");
    if (PUBLIC_MARKER.test(content)) continue;
    if (AUTH_KEYWORDS.test(content)) continue;

    issues.push({
      severity: "high",
      title: "API Route에 인증 관련 코드 없음",
      location: rel,
      hint: "의도적으로 공개 API 면 파일에 `// @public` 주석 추가"
    });
  }
}

function checkRateLimit(files, rootDir, issues) {
  const SENSITIVE_ROUTE = /\/(login|signin|signup|register|password|reset|payment|checkout|webhook|verify-otp|send-sms)/i;
  const RATE_LIMIT_KEYWORDS = /rate.?limit|ratelimit|throttle|slowdown|upstash|bottleneck|express-rate-limit|@vercel\/edge.*limit/i;

  for (const file of files) {
    if (!isCodeFile(file)) continue;
    const rel = relPath(file, rootDir);
    if (!SENSITIVE_ROUTE.test(rel)) continue;

    const content = fs.readFileSync(file, "utf-8");
    if (RATE_LIMIT_KEYWORDS.test(content)) continue;

    // middleware.ts 에서 처리하는 경우도 있으므로 severity 를 medium 으로
    issues.push({
      severity: "medium",
      title: "민감 엔드포인트에 rate limit 코드 없음",
      location: rel,
      hint: "로그인/결제/웹훅/SMS 등은 brute force·남용 방어 필수. middleware나 라우트 내부에서 rate limit 적용"
    });
  }
}

// -----------------------------
// 엔트리
// -----------------------------
export async function runStatic(rootDir) {
  const issues = [];
  const files = [];

  for (const file of walkFiles(rootDir)) {
    files.push(file);
  }

  const envFiles = files.filter(isEnvFile);

  checkGitignore(rootDir, envFiles, issues);
  checkEnvPublicLeaks(files, rootDir, issues);
  checkSecrets(files, rootDir, issues);
  checkCodePatterns(files, rootDir, issues);
  checkWebhooks(files, rootDir, issues);
  checkSqlRls(files, rootDir, issues);
  checkApiAuth(files, rootDir, issues);
  checkRateLimit(files, rootDir, issues);

  return issues;
}
