# CORS & API 보안 가이드

> 대상: 내 서버가 API를 제공할 때 / CORS 에러 뜨는데 `*`로 해결하려는 순간.
> 가장 잘못된 "해결법"이 가장 큰 문제를 만드는 영역.

## 왜 자주 터지나

AI는 "CORS 에러 나면 `Access-Control-Allow-Origin: *`로 해결" 같은 Stack Overflow 답변을 그대로 재생산합니다. 이게 **credentials: include**와 만나면 전 세계에 세션 쿠키 공개하는 결과.

## 피해 실예

- **CORS `*` + credentials**: 인증 쿠키가 다른 도메인에서도 자동 전송 → 피싱 사이트가 내 로그인 세션으로 API 호출 가능 (CSRF와 유사한 결과)
- **CSRF 방어 없음**: 사용자가 공격자 사이트 방문만 해도 내 계정에서 글 자동 작성됨
- **API에 rate limit 없음**: 로그인 엔드포인트 brute force, AI API 엔드포인트 비용 공격
- **에러 응답에 스택 트레이스**: DB 테이블명·쿼리·내부 경로 그대로 노출

## 핵심 원칙 6가지

### 1. CORS는 `*` 대신 명시 allowlist

```ts
// ❌ 위험
app.use(cors({ origin: '*', credentials: true }))  // ← 이 조합은 사실 브라우저가 거부

// ❌ 위험 — 전부 반사
app.use(cors({
  origin: (origin, cb) => cb(null, origin || true),  // 어떤 origin이든 승인
  credentials: true
}))

// ✅ 명시 allowlist
const ALLOWED = ['https://myapp.com', 'https://www.myapp.com']
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED.includes(origin)) return cb(null, true)
    cb(new Error('Not allowed by CORS'))
  },
  credentials: true
}))
```

**`*`를 써도 되는 유일한 경우**: 크레덴셜 없는 완전 공개 API (RSS, 공개 통계 등). 로그인 세션 쿠키 오가는 API는 절대 `*`.

### 2. CSRF 방어

세션 쿠키 기반이면 CSRF 필수. 옵션:

**(a) SameSite 쿠키 (1차 방어)**
```ts
res.cookie('session', token, { sameSite: 'lax' })
```
`lax`면 대부분의 CSRF 차단. `strict`면 더 강하지만 외부 링크 클릭 시 세션 소실.

**(b) CSRF 토큰**
```ts
// 각 폼에 고유 토큰 생성
const csrfToken = crypto.randomBytes(32).toString('hex')
res.cookie('csrf', csrfToken, { sameSite: 'lax' })

// 상태 변경 요청마다 헤더로 토큰 검증
app.post('/api/*', (req, res, next) => {
  if (req.cookies.csrf !== req.headers['x-csrf-token']) {
    return res.status(403).json({ error: 'CSRF' })
  }
  next()
})
```

**(c) Origin/Referer 검증 (간단 & 효과적)**
```ts
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin || req.headers.referer
    if (!origin || !ALLOWED.some(a => origin.startsWith(a))) {
      return res.status(403).json({ error: 'Bad origin' })
    }
  }
  next()
})
```

SameSite=Lax + Origin 검증 조합이 실전에서 가장 현실적.

### 3. Rate limit

[Upstash Rate Limit](https://github.com/upstash/ratelimit-js) 같은 거면 Edge에서도 동작:

```ts
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

const limiter = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, '1 m')  // IP당 분당 10회
})

app.use('/api/auth/*', async (req, res, next) => {
  const { success } = await limiter.limit(req.ip)
  if (!success) return res.status(429).json({ error: 'Too many requests' })
  next()
})
```

라우트별 적절한 한도:
- 로그인·회원가입·재설정: 5분에 5회 per IP
- AI API: 사용자당 분당 10회
- 일반 CRUD: IP당 분당 120회
- 결제 웹훅: 무제한 (IP allowlist로만 방어)

### 4. 에러 응답은 일반화

```ts
// ❌ 내부 정보 노출
catch (err) {
  res.status(500).json({ error: err.message, stack: err.stack })
}

// ✅ 사용자 메시지 + 서버 로그에만 상세
catch (err) {
  logger.error({ err, userId: req.user?.id, path: req.path })
  res.status(500).json({ error: 'Internal server error' })
}
```

프로덕션에서 stack trace / SQL 에러 / env 값 그대로 JSON 응답에 실리는 경우가 놀랍도록 흔함.

### 5. HTTPS 강제 + HSTS

```
# next.config.mjs
async headers() {
  return [{
    source: '/:path*',
    headers: [
      { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ]
  }]
}
```

### 6. API 버전 관리 + 깔끔한 deprecation

구 엔드포인트가 보안 패치 못 받고 오래 남는 게 흔한 경로.
`/api/v1/*`, `/api/v2/*` 분리하고 v1은 일정 후 완전 제거.

## AI에게 시킬 때 덧붙일 프롬프트

````
API 서버 코드 작성 시 다음 규칙:

1. CORS는 명시적 origin allowlist만. '*'는 credentials 없는 완전 공개 API에만.
   환경변수 ALLOWED_ORIGINS=https://myapp.com,https://www.myapp.com 로 관리.
2. 상태 변경 요청(POST/PUT/DELETE)에는 CSRF 방어 — SameSite=Lax 쿠키 +
   Origin/Referer 헤더 검증 최소 적용.
3. 로그인·가입·결제·AI 라우트에 rate limit(IP 또는 사용자당).
4. 에러 응답은 {error: '사용자용 메시지'}만. 스택·쿼리·내부 경로 노출 금지.
   상세는 logger로 서버 측에만 기록.
5. 응답 헤더에 HSTS + X-Content-Type-Options + X-Frame-Options + Referrer-Policy
   기본 포함.
6. 개별 엔드포인트마다 인증/권한 체크(앞선 03-auth-session 참조).
````

## 지뢰 10개

1. **`Access-Control-Allow-Origin: *` + `credentials: true`** — 브라우저가 거부하지만, 잘못된 조합으로 설정 노출
2. **Origin 반사 (`origin: req.headers.origin`)** — 사실상 `*` + credentials
3. **SameSite 미설정** — CSRF 전면 노출
4. **에러 응답에 `err.stack`** — DB 구조/경로 유출
5. **로그인 엔드포인트 rate limit 없음** — brute force
6. **preflight OPTIONS에 인증 미들웨어 잘못 적용** — 404/500 → 실제 요청 전부 실패
7. **공개 API에 HSTS 빠짐** — HTTP 다운그레이드 MITM
8. **프로덕션에 `NODE_ENV=development`** — 상세 에러 + 디버그 로그 노출
9. **API 키를 쿼리 파라미터로** — 서버 액세스 로그에 영구 기록
10. **CORS preflight 캐시 max-age 너무 김** — 설정 변경 후 몇 시간 반영 안 됨

## 머지 전 체크리스트

- [ ] CORS origin allowlist 명시 (와일드카드 없음)
- [ ] credentials 쓴다면 SameSite=Lax + Origin 검증
- [ ] 로그인·가입·결제·AI 라우트 rate limit
- [ ] 에러 응답에 스택·내부 경로 없음
- [ ] 프로덕션 응답 헤더에 HSTS, X-Frame-Options, X-Content-Type-Options
- [ ] `NODE_ENV=production` 배포
- [ ] API 키는 헤더(X-API-Key) 또는 body, 쿼리 금지
- [ ] preflight(OPTIONS)에 인증 미들웨어 생략하도록 분기
- [ ] 구 API 버전(`/api/v1`) deprecation 일정 있음
- [ ] Cloudflare/Vercel의 WAF/Bot 관리 한 번 체크

## 참고
- OWASP CORS: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- MDN CORS: https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS
