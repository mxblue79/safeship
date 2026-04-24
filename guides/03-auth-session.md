# 인증 & 세션 보안 가이드

> 대상: 로그인 / 회원가입 / 비밀번호 재설정 / OAuth / 매직링크 구현할 때.
> 초보자가 가장 많이 틀리는 영역. 버그 하나로 전 계정 탈취 가능.

## 왜 자주 터지나

AI가 만드는 인증 코드는 보통 "동작은 하지만 방어는 엉성". 덜 명시적으로 시키면 토큰 만료·로테이션·서버 측 권한 체크 전부 빠집니다.

## 피해 실예

- **세션 쿠키 HttpOnly 미설정**: 어디든 XSS 한 번 뚫리면 `document.cookie`로 세션 탈취
- **비밀번호 재설정 토큰 무한 유효**: 공격자가 과거 유출된 링크로 몇 개월 뒤 계정 인수
- **이메일 열거**: `/login`에서 "해당 이메일 없습니다" vs "비밀번호 틀렸습니다" 구분 → 가입된 이메일 전수조사
- **OAuth redirect 와일드카드**: `https://myapp.com/*` 허용 → `/../attacker.com` 같이 우회해 토큰 가로챔
- **관리자 판정을 body로**: `isAdmin: true` 포함한 request를 그대로 신뢰

## 핵심 원칙 6가지

### 1. 비밀번호는 bcrypt/argon2, SHA 단독 금지

```ts
// ❌ 절대 금지 — rainbow table으로 복호화 가능
const hash = crypto.createHash('sha256').update(password).digest('hex')

// ✅ bcrypt (범용)
import bcrypt from 'bcrypt'
const hash = await bcrypt.hash(password, 12)  // cost 10~12
const ok = await bcrypt.compare(password, storedHash)

// ✅ argon2 (더 권장, Go/Rust 커뮤니티 선호)
import argon2 from 'argon2'
const hash = await argon2.hash(password)
```

### 2. 세션 쿠키 설정

```ts
res.cookie('session', token, {
  httpOnly: true,        // JS에서 못 읽음 (XSS 방어)
  secure: true,          // HTTPS에서만 전송
  sameSite: 'lax',       // CSRF 기본 방어 (또는 'strict')
  maxAge: 7 * 24 * 3600 * 1000,  // 7일
  path: '/',
})
```

`sameSite`가 `'none'`이 되는 건 크로스사이트가 진짜 필요할 때만. 그 경우 `secure: true` 필수 + **별도 CSRF 토큰** 추가.

### 3. 이메일 열거 방지

```ts
// ❌ 공격자가 가입된 이메일 수집
if (!user) return res.status(404).json({ error: '해당 이메일 없습니다' })
if (!passwordOk) return res.status(401).json({ error: '비밀번호 틀렸습니다' })

// ✅ 동일 메시지 + 동일 응답 시간
if (!user || !passwordOk) {
  return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다' })
}
```

회원가입도 비슷:
```ts
// "이미 가입된 이메일" 직접 노출하지 말고, 메일로 "가입 성공 or 이미 계정 있음" 안내
```

### 4. 매직링크·비밀번호 재설정 토큰은 1회용 + 짧은 TTL

```ts
// 저장 시
const token = crypto.randomBytes(32).toString('hex')  // 64자 난수
await db.tokens.create({
  email,
  token,
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),  // 15분
  usedAt: null,
})

// 검증 시
const t = await db.tokens.findFirst({ where: { token } })
if (!t || t.usedAt || t.expiresAt < new Date()) {
  return res.status(400).json({ error: 'Invalid or expired' })
}
await db.tokens.update({ where: { id: t.id }, data: { usedAt: new Date() } })
// 재설정 후엔 기존 세션 전부 무효화
await db.sessions.deleteMany({ where: { email } })
```

### 5. OAuth redirect URI는 고정 경로

```
# ❌ 와일드카드 / 경로 조각
https://myapp.com/*
https://myapp.com/auth/*

# ✅ 정확한 URL
https://myapp.com/auth/callback
https://staging.myapp.com/auth/callback  (환경별 개별 등록)
```

### 6. 권한 체크는 서버 미들웨어 + claims에서 추출

```ts
// 미들웨어
async function requireAuth(req, res, next) {
  const token = req.cookies.session
  if (!token) return res.status(401).json({})
  const session = await db.sessions.findFirst({ where: { token, expiresAt: { gt: new Date() } } })
  if (!session) return res.status(401).json({})
  req.user = await db.users.find(session.userId)
  next()
}

async function requireAdmin(req, res, next) {
  if (!ADMIN_EMAILS.includes(req.user.email)) return res.status(403).json({})
  next()
}

app.get('/admin/users', requireAuth, requireAdmin, handler)
```

관리자 판정은 **반드시 서버가 아는 값(DB의 role, env의 allowlist)으로만**. 요청 body의 `isAdmin`은 절대 신뢰 금지.

## AI에게 시킬 때 덧붙일 프롬프트

````
인증·세션 코드 작성 시 다음 규칙:

1. 비밀번호는 bcrypt(cost ≥10) 또는 argon2. SHA/MD5 단독 해시 금지.
2. 세션 쿠키는 HttpOnly + Secure + SameSite=Lax/Strict.
3. 로그인 실패 메시지는 이메일 존재 여부를 노출하지 않도록 통일.
4. 매직링크·비밀번호 재설정 토큰은 32바이트 이상 난수, 15분 TTL, 1회용.
   사용 후 usedAt 기록하고, 해당 이메일의 모든 세션 무효화.
5. OAuth redirect URI는 정확한 URL로 등록(와일드카드·경로 조각 금지).
6. 모든 보호 API는 미들웨어(requireAuth, requireAdmin)로 게이트.
   프론트에서 if(isAdmin) 숨기는 것만으로는 보안이 아님.
7. 관리자 판정은 DB의 role 또는 env의 allowlist만 근거로. request body의
   role/isAdmin 필드는 무시.
8. 로그인 시도 rate limit(예: IP + 이메일당 5분에 5회) 적용.
9. 2FA 지원하면 최소한 관리자 계정은 강제.
````

## 지뢰 10개

1. **SHA256만으로 비밀번호 해시** — rainbow table 즉시 뚫림
2. **JWT secret이 `NEXT_PUBLIC_*`** — 누구나 토큰 위조
3. **JWT 만료 없거나 1년짜리** — 한 번 유출되면 1년 통제 불가
4. **HttpOnly 쿠키 대신 localStorage에 토큰** — XSS 한 방이면 끝
5. **로그아웃이 토큰 서버 무효화 없이 쿠키만 삭제** — 탈취된 토큰은 계속 유효
6. **재설정 토큰 URL에 이메일 포함** — Referer 유출 시 이메일+토큰 동시 유출
7. **OAuth state 파라미터 생략** — CSRF 발생, 공격자 계정과 피해자 계정 연결됨
8. **`isAdmin`을 쿠키에 평문 저장** — 클라이언트가 직접 바꿈
9. **로그인 라우트에 rate limit 없음** — 비밀번호 brute force
10. **`req.body.email`로 관리자 체크** — 공격자가 admin@site.com 보내면 통과

## 머지 전 체크리스트

- [ ] 비밀번호 bcrypt/argon2로 해시
- [ ] 세션/JWT 만료 짧게 (access 15분, refresh 7~30일)
- [ ] Refresh token DB 저장 + 로그아웃 시 무효화
- [ ] 쿠키 HttpOnly + Secure + SameSite
- [ ] 로그인·가입·재설정 응답이 이메일 열거 허용 안 함
- [ ] 매직링크/재설정 토큰 1회용 + 15분 TTL
- [ ] OAuth redirect URI 정확한 경로
- [ ] 모든 보호 API에 인증 미들웨어
- [ ] 관리자 판정은 서버 측 근거만
- [ ] 로그인 실패 rate limit (IP + email)
- [ ] 관리자 계정 2FA 강제

## 참고
- OWASP Auth Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP Session Management: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
