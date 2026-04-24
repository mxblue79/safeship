/**
 * 배포된 URL의 HTTPS 설정과 보안 헤더 검증
 */
export async function runHttpChecks(url) {
  const issues = [];
  const target = url.startsWith("http") ? url : `https://${url}`;

  await checkHttpsRedirect(target, issues);
  await checkSecurityHeaders(target, issues);

  return issues;
}

async function checkHttpsRedirect(target, issues) {
  const httpUrl = target.replace(/^https:/, "http:");
  try {
    const resp = await fetch(httpUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000)
    });
    const loc = resp.headers.get("location") || "";
    const isRedirect = resp.status >= 300 && resp.status < 400;
    const toHttps = loc.startsWith("https:");

    if (!isRedirect || !toHttps) {
      issues.push({
        severity: "high",
        title: "HTTP → HTTPS 리다이렉트가 설정되지 않음",
        detail: `status=${resp.status}, location=${loc || "(없음)"}`,
        hint: "Vercel/Cloudflare에서 Force HTTPS 활성화, 또는 서버에서 301 리다이렉트 설정"
      });
    }
  } catch {
    // HTTP 포트 자체가 막혀 있으면 오히려 좋음 - 이슈 아님
  }
}

async function checkSecurityHeaders(target, issues) {
  let resp;
  try {
    resp = await fetch(target, { signal: AbortSignal.timeout(10000) });
  } catch (e) {
    issues.push({
      severity: "high",
      title: "대상 URL에 접근 실패",
      detail: e.message,
      hint: "URL이 올바른지, 배포되어 있는지 확인"
    });
    return;
  }

  const h = Object.fromEntries(
    [...resp.headers.entries()].map(([k, v]) => [k.toLowerCase(), v])
  );

  const headerChecks = [
    {
      name: "Strict-Transport-Security",
      valid: (v) => /max-age=\d+/.test(v) && parseInt(v.match(/max-age=(\d+)/)[1]) >= 31536000,
      severity: "high",
      hint: "Strict-Transport-Security: max-age=63072000; includeSubDomains; preload"
    },
    {
      name: "X-Content-Type-Options",
      valid: (v) => v?.toLowerCase() === "nosniff",
      severity: "medium",
      hint: "X-Content-Type-Options: nosniff"
    },
    {
      name: "X-Frame-Options",
      valid: (v) => /^(DENY|SAMEORIGIN)$/i.test(v),
      severity: "medium",
      hint: "X-Frame-Options: DENY (또는 CSP frame-ancestors 로 대체)"
    },
    {
      name: "Content-Security-Policy",
      valid: (v) => v && v.length > 0,
      severity: "medium",
      hint: "CSP 헤더 설정 (XSS 방어의 최후 방어선)"
    },
    {
      name: "Referrer-Policy",
      valid: (v) => v && v.length > 0,
      severity: "low",
      hint: "Referrer-Policy: strict-origin-when-cross-origin"
    },
    {
      name: "Permissions-Policy",
      valid: (v) => v && v.length > 0,
      severity: "low",
      hint: "불필요한 브라우저 API 비활성화 (camera=(), microphone=() 등)"
    },
  ];

  for (const check of headerChecks) {
    const val = h[check.name.toLowerCase()];
    if (!val || !check.valid(val)) {
      issues.push({
        severity: check.severity,
        title: `보안 헤더 누락/부적절: ${check.name}`,
        detail: val ? `현재 값: ${val}` : "헤더 없음",
        hint: check.hint
      });
    }
  }

  // 서버/프레임워크 정보 노출
  for (const header of ["server", "x-powered-by"]) {
    if (h[header]) {
      issues.push({
        severity: "low",
        title: `서버 정보 노출: ${header}`,
        detail: h[header],
        hint: "서버/프레임워크 버전 정보는 공격자에게 단서를 제공 — 제거 권장"
      });
    }
  }

  // CORS 전체 허용 확인
  const corsOrigin = h["access-control-allow-origin"];
  const corsCreds = h["access-control-allow-credentials"];
  if (corsOrigin === "*") {
    if (corsCreds === "true") {
      issues.push({
        severity: "critical",
        title: "CORS: Access-Control-Allow-Origin * + credentials:true 조합",
        hint: "이 조합은 브라우저도 거부. 도메인 화이트리스트 필수"
      });
    } else {
      issues.push({
        severity: "medium",
        title: "CORS: Access-Control-Allow-Origin = *",
        hint: "필요한 도메인만 허용하도록 변경"
      });
    }
  }
}
