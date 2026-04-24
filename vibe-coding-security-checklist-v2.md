# 바이브코딩 기반 상업용 서비스 보안 체크리스트 v2

> v1 대비 주요 추가: 멀티테넌트 격리 테스트, 런타임 검증 전략, Supabase RLS 세부 시나리오
> 대상: Next.js(프론트) + Supabase + Go(백엔드) + 결제 모듈 / 모바일 앱

---

## 0. 바이브코딩 특화 리스크

- [ ] **시크릿 하드코딩 점검** — API 키, JWT 시크릿, DB 비밀번호가 코드에 박혀있지 않은지 `gitleaks`, `trufflehog`, 혹은 safeship으로 스캔
- [ ] **`.env` 계열은 모두 `.gitignore`에 포함**
- [ ] **AI가 작성한 인증/결제/권한 로직은 사람이 한 줄씩 리뷰**
- [ ] **구버전 라이브러리 경고** — `npm audit`, `govulncheck` 필수
- [ ] **`any` 타입, `// TODO`, `// FIXME` 남긴 곳은 잠재 취약점 후보**
- [ ] **테스트 코드에 운영 키 포함 여부 확인**
- [ ] **"프론트에서 숨기는 것은 보안이 아니다"** — AI는 UI에서만 권한 체크하고 끝내는 코드를 자주 생성. 서버 측 체크 필수

---

## 1. 인증 & 세션

- [ ] 비밀번호는 bcrypt/argon2 (SHA 단독 금지)
- [ ] JWT access token 만료 짧게 (15분 권장)
- [ ] **Refresh token은 서버 DB에 저장 + 폐기 가능 구조** (단순 장기 JWT는 안 됨)
- [ ] 로그아웃 시 refresh token 서버 측 무효화
- [ ] **OAuth redirect URI는 정확한 URL로 고정** — 와일드카드(`*`)나 경로 조각 허용 금지
- [ ] 이메일 인증/비밀번호 재설정 토큰은 **1회용 + 짧은 TTL** (15분~1시간)
- [ ] 로그인 실패 횟수 제한 (brute force 방어)
- [ ] 2FA/MFA 최소한 관리자 계정 강제

---

## 2. 권한 관리 (RBAC)

- [ ] **모든 API 엔드포인트에 서버 측 권한 체크** — 프론트 숨김은 보안 아님
- [ ] `user_id`, `tenant_id`는 **클라이언트 입력이 아니라 JWT claims에서 추출**
- [ ] 관리자 전용 엔드포인트는 별도 미들웨어
- [ ] 리소스 소유권 체크 (본인 데이터만 수정 가능)

### 🔥 가장 흔한 실수
```ts
// ❌ 위험: 클라이언트가 user_id를 보냄
app.post('/posts', (req, res) => {
  db.insert({ user_id: req.body.user_id, ... })
})

// ✅ 올바름: 인증된 토큰에서 추출
app.post('/posts', requireAuth, (req, res) => {
  db.insert({ user_id: req.user.id, ... })
})
```

---

## 3. Next.js 프론트엔드

- [ ] `NEXT_PUBLIC_*`에 시크릿 절대 포함 금지
- [ ] Supabase **service_role key는 서버 전용**, `NEXT_PUBLIC_`로 시작하면 안 됨
- [ ] Server Component/Server Action에서만 시크릿 사용
- [ ] `middleware.ts`에서 보호 라우트 처리
- [ ] CSP 헤더 설정 (`next.config.js`의 `headers()`)
- [ ] `dangerouslySetInnerHTML`은 DOMPurify 필수
- [ ] SameSite cookie 설정 (CSRF 방어)
- [ ] HTTPS 강제 (HSTS)
- [ ] `next.config.js`의 `images.remotePatterns` 화이트리스트

---

## 4. Supabase 보안

### 4.1 RLS 기본
- [ ] 모든 테이블에 `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
- [ ] 기본은 `deny all`, 필요한 것만 허용
- [ ] `SELECT`, `INSERT`, `UPDATE`, `DELETE` 각각 정책 작성
- [ ] **INSERT/UPDATE 정책에 `WITH CHECK` 절 필수** — 없으면 클라이언트가 `tenant_id`를 변조해도 통과됨

```sql
-- ❌ 불완전
CREATE POLICY "users insert own" ON posts FOR INSERT
  USING (auth.uid() = user_id);

-- ✅ 올바름
CREATE POLICY "users insert own" ON posts FOR INSERT
  WITH CHECK (auth.uid() = user_id);
```

### 4.2 키 관리
- [ ] `service_role` 키는 서버 전용 (Edge Function, API Route, 백엔드)
- [ ] `anon` 키는 공개되어도 되지만 RLS가 제대로 걸려있다는 전제하에
- [ ] 키 유출 시 재발급 절차 숙지

### 4.3 실전 검증 (⭐ 중요)
정책만 작성하고 끝내지 말고 **실제로 anon 키로 찔러보기**:

```js
// anon 키로 직접 테이블 찔러보기
const { data } = await anon.from('users').select('*');
// data가 비어있지 않으면 RLS 누수
```

safeship의 `supabase` 명령으로 자동화 가능.

### 4.4 Storage
- [ ] 버킷별 개별 정책
- [ ] 공개/비공개 버킷 명확히 분리
- [ ] Signed URL 만료 짧게
- [ ] 업로드 용량·타입 제한

---

## 5. 멀티테넌트 격리 (⭐ 신규 섹션)

SaaS라면 이 섹션이 **Supabase RLS보다도 중요**합니다. 한 테넌트가 다른 테넌트 데이터에 접근하면 그 순간 서비스 끝입니다.

### 5.1 핵심 원칙
> **"tenant_id는 입력값이 아니라 서버/토큰에서 강제되는 값"**

### 5.2 정책 설계
```sql
-- JWT custom claim 기반
CREATE POLICY "tenant isolation" ON posts
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
```

- [ ] 모든 테넌트 관련 테이블에 정책 적용
- [ ] `USING` (읽기 필터)과 `WITH CHECK` (쓰기 검증) 둘 다
- [ ] JWT에 `tenant_id` custom claim 추가 (Supabase Auth hook)

### 5.3 반드시 해봐야 할 공격 시나리오
두 테넌트(A, B)의 실제 사용자 토큰으로 다음을 **직접 시도해서 막히는지 확인**:

| 시나리오 | 기대 | 실패 시 |
|---|---|---|
| User A가 `tenant_id = B`로 `.select()` | 빈 결과 | 치명적 정보 유출 |
| User A가 `tenant_id: B`로 `.insert()` | 실패 | 치명적 데이터 오염 |
| User A가 `.update().eq('tenant_id', B)` | 0 rows 영향 | 치명적 데이터 변조 |
| User A가 `.delete().eq('tenant_id', B)` | 0 rows 영향 | 서비스 종료급 |

### 5.4 자주 터지는 실수
- [ ] `tenant_id`를 요청 body/query로 받고 그대로 insert
- [ ] SELECT 정책만 걸고 INSERT/UPDATE/DELETE 누락
- [ ] `WITH CHECK` 없이 `USING`만 사용 → 변조한 INSERT 통과
- [ ] JOIN 쿼리에서 조인 대상 테이블 RLS 누락 → 우회 가능
- [ ] 관리자 API에서 `service_role` 남용 (검증 없이 모든 테넌트 접근)

### 5.5 JOIN 조심
```sql
-- users 테이블만 RLS 걸고 profiles는 안 걸면
SELECT p.* FROM profiles p JOIN users u ON p.user_id = u.id;
-- profiles 데이터가 그대로 노출될 수 있음
```

- [ ] **JOIN으로 참조되는 모든 테이블에 RLS 적용**

---

## 6. 런타임 검증 전략 (⭐ 신규 섹션)

정적 체크리스트는 "해야 할 일"을 정리한 것이고, 런타임 검증은 "실제로 됐는지"를 확인하는 것입니다. **둘은 다릅니다.**

### 6.1 3중 검증 체계

| 층위 | 도구 | 확인 대상 |
|---|---|---|
| 정적 | safeship static, gitleaks | 하드코딩 시크릿, 위험 코드 패턴 |
| 런타임 | safeship supabase, curl 스크립트 | RLS 실제 작동, 멀티테넌트 격리 |
| 설정 | safeship http, securityheaders.com | 배포된 환경의 헤더/TLS |

### 6.2 CI/CD 통합 권장
```yaml
# .github/workflows/security.yml 예시
- run: safeship static --json > static.json
- run: safeship supabase --json > runtime.json
- run: safeship http https://staging.example.com --json > http.json
```

- [ ] 배포 파이프라인에 보안 검사 단계 추가
- [ ] Critical/High 이슈 발견 시 배포 차단
- [ ] PR 머지 전에 정적 분석 통과 필수

### 6.3 주기적 재검증
- [ ] 새 테이블 추가 시 RLS 검사
- [ ] Supabase 정책 변경 시 자동 테스트 재실행
- [ ] 월 1회 전체 재스캔 (의존성 업데이트 반영)

---

## 7. Go 백엔드 보안

- [ ] `database/sql` / `sqlx` / `pgx` 사용 시 placeholder 바인딩만 (`$1`, `$2`)
- [ ] HTTP 핸들러 context 시간 제한
- [ ] `http.Server`에 `ReadTimeout`, `WriteTimeout`, `IdleTimeout` 명시
- [ ] JWT 라이브러리 최신 (`github.com/golang-jwt/jwt/v5`)
- [ ] 고루틴 누수 방어 — context 전파, 채널 close
- [ ] 민감 데이터 비교는 `crypto/subtle.ConstantTimeCompare` (timing attack)
- [ ] CORS: `AllowOrigins: ["*"]` + `AllowCredentials: true` 조합 금지
- [ ] `govulncheck ./...` CI 필수
- [ ] 에러 메시지 내부 정보 노출 금지

---

## 8. 결제 모듈

### 8.1 절대 원칙
- [ ] 카드번호/CVC/유효기간을 **서버에 저장·로깅 금지** (PCI DSS)
- [ ] PG사 토큰/세션 방식 사용 (토스페이먼츠, 포트원/아임포트, Stripe)
- [ ] **결제 금액은 서버에서 재계산** — 클라이언트 금액 신뢰 금지
- [ ] **PG 서버 대 서버 검증** — 클라이언트 성공 응답만 믿지 말 것

### 8.2 웹훅
- [ ] 웹훅 URL 서명 검증 필수 (PG 시크릿으로 HMAC)
- [ ] **멱등성(idempotency) 키** 처리 — 재전송 대비
- [ ] 웹훅 엔드포인트 레이트 리미팅 + IP 화이트리스트

### 8.3 주문/결제 플로우
- [ ] 주문→결제→승인→DB 반영 트랜잭션
- [ ] 이중 결제 방지
- [ ] 환불은 별도 권한 + 감사 로그
- [ ] 실패/중도 이탈 주문 정리 배치

### 8.4 한국 특화
- [ ] 전자금융거래법 검토 (선불전자지급수단 해당 여부)
- [ ] 전자상거래법 — 청약철회, 사업자 정보 표시
- [ ] 간편결제(토스페이/카카오페이/네이버페이) 각사 가이드 준수
- [ ] 세금계산서·현금영수증 자동 발행

---

## 9. 모바일 앱

### 9.1 스택 및 결제
- [ ] **IAP 해당 여부 확인** — 디지털 콘텐츠/구독은 애플·구글 자체결제 강제 / 실물·오프라인은 외부 PG 허용
- [ ] 서버 측 **영수증 검증 필수** (클라이언트 응답 신뢰 금지)

### 9.2 공통
- [ ] API 키 앱 번들 하드코딩 금지 (리버스 엔지니어링됨)
- [ ] Keychain(iOS) / Keystore(Android)에 민감 데이터 저장
- [ ] Certificate Pinning (금융·결제 앱)
- [ ] 루팅/탈옥 탐지
- [ ] 코드 난독화 (R8/ProGuard, iOS 심볼 스트립)
- [ ] 딥링크 파라미터 검증
- [ ] 프로덕션 빌드 디버그 로그 제거
- [ ] 백그라운드 전환 시 민감 화면 블러

### 9.3 스토어 심사
- [ ] 개인정보 수집 명시 (Privacy Nutrition Label / Data Safety)
- [ ] 계정 삭제 기능 필수 (Apple 요구)

---

## 10. 인프라 & 운영

- [ ] GitHub 시크릿 스캔 활성화
- [ ] Vercel/Cloudflare 환경변수 암호화
- [ ] staging / production 분리
- [ ] 관리자 페이지 IP 화이트리스트 또는 VPN
- [ ] 관리자 계정 2FA 강제
- [ ] DB 백업 자동화 + 복구 테스트
- [ ] 접근 로그 6개월 이상 보관
- [ ] API 키 rotate 가능한 구조
- [ ] 퇴사자 권한 회수 SOP

---

## 11. 한국 법규

- [ ] 개인정보보호법 — 동의, 보관기간, 파기, 처리방침
- [ ] 정보통신망법
- [ ] 전자상거래법 — 사업자 정보, 청약철회
- [ ] 전자금융거래법 (결제 시)
- [ ] 14세 미만 법정대리인 동의 (해당 시)
- [ ] 개인정보처리방침 페이지
- [ ] 사업자등록번호, 통신판매업 신고번호 표시
- [ ] ISMS-P 대상 여부 확인

---

## 12. 출시 전 최종 점검

- [ ] **외부 침투 테스트 최소 1회** (결제 있으면 필수)
- [ ] OWASP ZAP / Burp Suite 스캔
- [ ] `npm audit --production`, `govulncheck` Clean
- [ ] `securityheaders.com`, `ssllabs.com` A 등급 이상
- [ ] 개인정보처리방침·이용약관 법무 검토
- [ ] 결제 실제 카드로 전 시나리오 테스트 (성공/실패/환불/중복)
- [ ] 멀티테넌트 격리 테스트 통과
- [ ] 모니터링·알림 가동 (Sentry, Supabase Logs, PG 대시보드)

---

## 우선순위 TOP 6 (시간 없을 때)

이것만이라도 지키면 "서비스 터지는 사고"는 대부분 막힙니다:

1. **Supabase RLS 활성화 + 정책 작성 + 런타임 검증**
2. **모든 API에 서버 측 인증/권한 체크**
3. **결제 웹훅 서명 검증 + 금액 서버 재계산**
4. **`service_role` 키 서버 전용 유지**
5. **비밀번호 bcrypt/argon2 해시 + 환경변수 Git 제외**
6. **HTTPS 강제 + HSTS 헤더**

---

## 핵심 한 줄

> **정적 체크리스트는 "해야 할 일"이고, 런타임 검증은 "실제로 됐는지"다. 상용 서비스는 둘 다 필요하다.**
