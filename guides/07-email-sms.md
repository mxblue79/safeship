# 이메일 / SMS 발송 보안 가이드

> 대상: SendGrid / AWS SES / Mailgun / Resend / Twilio / 국내 SMS API 사용.
> 도메인 평판 망가지면 복구 몇 주 걸림. SMS는 건당 유료라 금전 피해도 큼.

## 왜 자주 터지나

메일·SMS 발송 엔드포인트는 "누가 호출하든 메시지 나간다"는 점에서 **자동 과금 기계**와 같습니다. 레이트 리밋, 수신자 소유권 검증, 스푸핑 방어가 누락되면 비용·평판 모두 타격.

## 피해 실예

- **매직 링크 발송 남용**: 누구나 호출 가능한 `/send-magic-link`에 `{email: victim@corp.com}` 무한 전송 → 피해자 메일함 도배, FairPicker 도메인이 스팸 블랙리스트 등록
- **SMS 인증 비용 폭격**: 가입 시 SMS 발송, rate limit 없음 → 공격자가 외국 번호에 수만 건 발송 → 한 번에 수십만원 SMS 청구서
- **헤더 인젝션**: 사용자 입력 이메일을 `To:` 헤더에 그대로 interpolate → `\r\nBcc: attacker@x.com` 주입 → 스팸 중계서버로 악용
- **SPF/DKIM 미설정**: 메일이 스팸함 직행 + 누군가 내 도메인 스푸핑 가능
- **관리자 메일 주소를 prod 로그에 평문 노출**

## 핵심 원칙 6가지

### 1. 수신자 검증 + 레이트리밋 이중화

```ts
app.post('/send-magic-link', async (req, res) => {
  const { email } = req.body
  if (!isValidEmail(email)) return res.status(400).json({})

  // ① 이메일당 레이트리밋 (공격자가 여러 IP로 우회해도 피해자 보호)
  const recent = await db.magicLinks.count({
    email, createdAt: { gt: new Date(Date.now() - 15 * 60 * 1000) }
  })
  if (recent >= 3) return res.status(429).json({})

  // ② IP당 레이트리밋 (한 공격자가 여러 이메일 공격 방지)
  const { success } = await ratelimit.limit(`magic:${req.ip}`)
  if (!success) return res.status(429).json({})

  // ③ 일일 캡 (저속 확산 공격 방지)
  const daily = await db.magicLinks.count({
    email, createdAt: { gt: new Date(Date.now() - 24 * 3600 * 1000) }
  })
  if (daily >= 10) return res.status(429).json({})

  // ④ Turnstile/reCAPTCHA (자동 스크립트 차단)
  if (!(await verifyTurnstile(req.body.turnstileToken, req.ip))) {
    return res.status(403).json({})
  }

  await sendMagicLink(email)
  res.json({ ok: true })
})
```

### 2. 헤더 인젝션 방어

이메일 라이브러리 (nodemailer, resend-sdk 등)는 대부분 내부에서 `\r\n`을 제거하지만, **직접 SMTP를 다루거나 To/Cc/Bcc에 raw 문자열 넣을 때 조심.**

```ts
// ❌ 위험
const to = req.body.email  // "victim@x.com\r\nBcc: attacker@x.com"
smtp.send({ to, ... })

// ✅ 이메일 정규식 검증 먼저
if (!/^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.test(email)) {
  return res.status(400).json({})
}
```

### 3. SPF + DKIM + DMARC 설정

메일 도메인의 DNS에 **최소 셋 다 설정**:
- **SPF**: "이 도메인의 메일은 이 IP/서비스에서만 발송"
- **DKIM**: 메일 본문 서명 → 위조 방지
- **DMARC**: 위 둘 실패 시 정책 (quarantine/reject)

없으면:
- 내가 보내는 메일이 스팸함 직행
- 누구나 내 도메인 사칭 가능 (`admin@mydomain.com`으로 피싱)

Resend/SendGrid 대시보드에 자동 설정 가이드 있음. **배포 전 필수**.

### 4. SMS는 목적지 국가 제한

```ts
// ❌ 전 세계 번호로 발송 가능
await twilio.messages.create({ to: userInput, body: '...' })

// ✅ 허용 국가 화이트리스트
const ALLOWED_COUNTRIES = ['KR', 'US', 'JP']
if (!ALLOWED_COUNTRIES.includes(getCountryCode(userInput))) {
  return res.status(400).json({ error: '해당 국가 지원 안 함' })
}
```

"Toll fraud" 공격: 공격자가 해외 프리미엄 번호로 수신 회선을 세팅하고, 내 서비스에서 거기로 SMS 유도 → 건당 수천원 부과. **해외 번호 기본 차단**이 안전.

### 5. 템플릿에 user input 넣을 땐 이스케이프

```ts
// ❌ HTML 이메일 템플릿에 사용자 입력 그대로
const html = `<p>안녕하세요 ${userName}님</p>`  // userName = "<script>..."

// ✅ HTML 엔티티 이스케이프
import escape from 'escape-html'
const html = `<p>안녕하세요 ${escape(userName)}님</p>`
// 또는 템플릿 엔진(Handlebars, MJML 등)의 자동 이스케이프 사용
```

### 6. 발송 주체 권한 확인

```ts
// ❌ 누구나 호출 가능한 "초대 메일" 엔드포인트
app.post('/invite', async (req, res) => {
  await sendInvite(req.body.inviteeEmail, req.body.projectId)
})

// ✅ 인증 + 프로젝트 소유권 검증
app.post('/invite', requireAuth, async (req, res) => {
  const project = await db.projects.find(req.body.projectId)
  if (project.ownerId !== req.user.id) return res.status(403).json({})
  await sendInvite(req.body.inviteeEmail, project.id)
})
```

## AI에게 시킬 때 덧붙일 프롬프트

````
이메일/SMS 발송 코드 작성 시 다음 규칙:

1. 수신자 입력은 엄격한 정규식으로 검증(공백·개행 포함 시 거부).
   To/Cc/Bcc 필드에 user input을 interpolate할 때 \\r\\n 차단 필수.
2. 발송 엔드포인트에는 IP당 rate limit + 수신자(이메일/번호)당 rate limit +
   일일 캡을 이중 삼중으로 적용. 자동 스크립트는 Turnstile/reCAPTCHA로 차단.
3. SMS는 목적지 국가 화이트리스트. 해외 번호는 기본 차단 후 명시 허용.
4. HTML 이메일에 사용자 입력을 넣을 땐 escape-html 또는 자동 이스케이프
   템플릿 엔진 사용.
5. 발송 전 "이 사용자가 정말 수신자에게 보낼 권한이 있는지" 서버에서 검증.
   예: 초대는 프로젝트 소유자만, 매직링크는 본인만.
6. 프로덕션 배포 전 SPF/DKIM/DMARC DNS 레코드 설정 확인.
7. 발송 실패/거절 로그는 이메일 주소 전체 대신 해시 또는 마스킹으로 기록.
````

## 지뢰 10개

1. **누구나 호출 가능한 `/send-magic-link`** — 피해자 도메인에 무한 발송
2. **이메일당 rate limit 없음** — 동일 수신자에게 도배
3. **SPF/DKIM/DMARC 미설정** — 메일이 스팸함, 도메인 사칭 가능
4. **SMS 국가 제한 없음** — toll fraud 취약
5. **헤더 인젝션 방어 없음** — To 필드에 `\r\nBcc:`로 스팸 중계
6. **Resend/SendGrid 테스트 모드 키를 production에** — 실제 발송 안 되는데 성공 응답
7. **매직링크 토큰 만료 없음/길음** — 몇 달 뒤까지 유효
8. **이메일 템플릿에 raw HTML 주입** — 스토어드 XSS (첨부된 signature 등)
9. **발송 대량 병렬 처리** — SendGrid quota 초과 + 일부 실패 무시
10. **관리자 연락처 하드코딩** — 소스 코드 유출 시 스피어 피싱 대상 노출

## 머지 전 체크리스트

- [ ] 수신자 검증 정규식 (공백·개행 차단)
- [ ] IP·수신자·일일 3중 rate limit
- [ ] 자동 스크립트 차단 (Turnstile·reCAPTCHA)
- [ ] SMS 국가 화이트리스트
- [ ] 템플릿 자동 이스케이프 사용
- [ ] 발송자 권한 검증 (인증 + 리소스 소유권)
- [ ] 토큰은 1회용 + 15분 TTL
- [ ] SPF·DKIM·DMARC 설정 (DNS 확인)
- [ ] 테스트 키와 프로덕션 키 분리 배포
- [ ] 로그에 이메일 full 주소 대신 마스킹
- [ ] 발송 실패 알림 + 일일 발송량 모니터링

## 참고
- Resend Deliverability: https://resend.com/docs/dashboard/domains/introduction
- SendGrid Authentication: https://docs.sendgrid.com/ui/account-and-settings/how-to-set-up-domain-authentication
- Twilio Toll Fraud: https://support.twilio.com/hc/en-us/articles/8360406546587-International-Revenue-Share-Fraud-IRSF
