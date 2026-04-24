# 배포 & 인프라 보안 가이드

> 대상: Vercel / Railway / Netlify / AWS / Fly.io / Render / 본인 VPS 배포.
> 코드가 안전해도 인프라 설정 한 줄이 전부를 뚫을 수 있는 영역.

## 왜 자주 터지나

바이브코더는 배포를 **"빌드 성공 = 완료"**로 생각하기 쉽습니다. 실제로는 배포 후 환경변수·도메인·헤더·백업·관측 설정이 제대로 되어야 **운영 보안**이 시작됩니다.

## 피해 실예

- **환경변수를 GitHub Actions 로그에 출력**: `echo $STRIPE_SECRET`으로 디버깅 → CI 로그 공개되어 유출
- **Vercel preview 환경에 프로덕션 DB 연결**: 브랜치마다 preview URL 공개 + 프로덕션 데이터 접근
- **Railway에서 `.env`를 git에 커밋**: preview 배포할 때 편하라고 커밋 → 그대로 노출
- **Cloudflare 무료 플랜 DDoS 보호 미적용**: 봇 공격 몇 시간에 서비스 다운
- **관리자 대시보드(Supabase Studio, pgAdmin)를 public URL로**: 인증 없거나 기본 비밀번호
- **Docker 이미지에 `.env` 포함**: 레지스트리 public이면 전 세계 조회 가능

## 핵심 원칙 7가지

### 1. 환경변수는 플랫폼 UI에서만 주입

```
❌ .env를 git 커밋 (공개/비공개 무관)
❌ GitHub Secrets에 저장 후 CI에서 파일로 쓰기
❌ Dockerfile의 ENV STRIPE_KEY=...

✅ Vercel: Project Settings → Environment Variables (Production/Preview/Development 분리)
✅ Railway: Variables 탭에 직접 붙여넣기
✅ AWS: Parameter Store / Secrets Manager
```

환경변수를 여러 환경(prod/preview/dev)에 분리:
- **Production**: 실제 DB, 실제 결제 키
- **Preview**: 격리된 preview DB, test 결제 키
- **Development**: 로컬 개발용

프로덕션 키가 preview/dev에 새어나가지 않게.

### 2. Preview 배포 환경 보호

Vercel/Netlify의 preview URL은 **모든 브랜치가 공개 URL 생성** — 개발 중인 기능이 검색 노출됨.

```
# Vercel: Project Settings → Deployment Protection
- Password Protection (비밀번호 필요)
- Vercel Authentication (팀원만 접근)

# Netlify: Branch Deploy 비활성화 또는 Password Protection
```

**더 중요**: preview 환경이 프로덕션 DB를 쓰지 않게. 전용 preview DB 또는 read-replica.

### 3. 관리자 도구는 공개 노출 금지

```
❌ https://myapp.com:5555 (Prisma Studio 인증 없음)
❌ https://myapp.com/pgadmin (기본 admin/admin)
❌ Supabase Studio 로컬 포트가 ngrok으로 공개

✅ SSH 터널로만 접근: ssh -L 5555:localhost:5555 server
✅ Cloudflare Access로 인증 게이트 (무료 티어)
✅ VPN (Tailscale 무료 티어) 안에서만 접근
```

### 4. HTTPS 강제 + 보안 헤더

Vercel/Netlify는 자동 HTTPS 제공. VPS 직접 운영이면:
- Let's Encrypt 인증서 (Certbot 자동 갱신)
- HTTP → HTTPS 리다이렉트
- HSTS 헤더 (max-age 1년+)

보안 헤더는 `next.config.mjs` 또는 reverse proxy(nginx/Caddy):
```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy: (프로젝트별 구성)
```

### 5. DDoS / 봇 방어

```
✅ Cloudflare 무료 플랜이면 대부분 커버:
   - DNS를 Cloudflare에 위탁
   - Proxy(주황 구름) 켜기
   - Bot Fight Mode 활성화
   - Rate Limiting Rules (무료 10규칙)

✅ Vercel은 자체 DDoS 방어 있음. 추가로 Web Application Firewall(유료) 고려.
```

민감 엔드포인트에 직접 rate limit 있어도, 외곽 레이어에서 한 번 더 걸러야 비용·트래픽 절약.

### 6. 백업 + 복구 테스트

```
✅ DB 자동 백업 활성화 (Supabase는 유료 플랜만, Railway는 Pro, AWS RDS는 기본)
✅ 백업 주기 매일 최소, 보존 7~30일
✅ 복구 시나리오 한 번 실제 테스트 — "백업이 있다"와 "복원 된다"는 별개 문제
```

중요: 백업 파일 자체가 스토리지 public이면 백업이 유출 경로가 됩니다. 암호화 + 접근 제한.

### 7. 로그·모니터링

```
✅ Sentry (에러 추적) — 무료 티어 후함
✅ Uptime Robot / Better Stack — 서비스 다운 알림
✅ 결제/가입 같은 중요 이벤트는 Slack/Discord 실시간 알림
✅ 로그에 PII·카드번호·토큰 전체 기록 금지 (Sentry beforeSend로 마스킹)
```

로그가 있어야 **사고 후 무슨 일이 있었는지 파악** 가능. 없으면 원인 불명.

## AI에게 시킬 때 덧붙일 프롬프트

````
배포 설정 작업 시 다음 규칙:

1. 시크릿은 .env 파일을 git 커밋하지 말고 플랫폼의 환경변수 UI에 직접 입력.
   .env.example만 커밋(빈 값).
2. Production / Preview / Development 환경변수 분리. preview가 프로덕션 DB에
   연결되지 않도록.
3. Vercel/Netlify의 preview 배포는 비공개(Password Protection 또는 팀 인증).
4. 관리자 도구(Prisma Studio, pgAdmin, Supabase Studio)는 공개 URL 금지.
   SSH 터널 또는 Cloudflare Access/Tailscale 뒤에만.
5. 응답 헤더에 HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
   Permissions-Policy, Content-Security-Policy 기본 포함.
6. Cloudflare DNS + Proxy 활성화 (DDoS 1차 방어 무료 제공).
7. DB 자동 백업 활성화 + 복구 시나리오 1회 테스트.
8. Sentry 등 에러 모니터링 연결. beforeSend에서 쿠키·authorization 헤더 마스킹.
````

## 지뢰 10개

1. **`.env` 커밋** — Public·Private 무관 (관련 가이드 §0)
2. **CI 로그에 시크릿 echo** — GitHub Actions 공개 로그에 영구 저장
3. **Preview 배포가 프로덕션 DB 사용** — 브랜치 하나가 실제 데이터 날림
4. **Dockerfile에 `ENV SECRET_KEY=...`** — 이미지에 평문 박힘, `docker history`로 노출
5. **기본 비밀번호로 배포** — Postgres `postgres/postgres`, Redis 패스워드 없음
6. **관리자 도구 공개 URL** — 인증 없거나 약한 비밀번호
7. **DNS에서 스테이징 도메인 인덱싱** — `staging.myapp.com`이 Google에 노출
8. **GitHub Pages / Netlify free에 진짜 서비스** — 이용 약관 위반 + SLA 없음
9. **백업 파일 public 스토리지** — 자체가 유출 경로
10. **모니터링 없음** — 사고가 나도 몇 시간 후에야 발견

## 머지 전 체크리스트

- [ ] `.env*`가 `.gitignore`에 포함, `git ls-files`로 추적 없음 확인
- [ ] 플랫폼 UI에 prod/preview/dev 환경변수 분리
- [ ] Preview 배포 비공개(Password 또는 팀 인증)
- [ ] Preview는 프로덕션 DB에 연결 안 됨
- [ ] 관리자 도구는 SSH 터널·Cloudflare Access·VPN 뒤
- [ ] HTTPS 자동 갱신 확인(만료 전 알림 설정)
- [ ] HSTS + 보안 헤더 6종 응답에 포함(curl로 확인)
- [ ] Cloudflare DNS/Proxy 활성화
- [ ] DB 자동 백업 활성 + 최근 복구 테스트 1회 완료
- [ ] Sentry 에러 추적 + PII 마스킹
- [ ] Uptime 모니터링 + 다운 알림
- [ ] 중요 이벤트(결제, 가입) Slack 알림
- [ ] 도메인 WHOIS 공개 정보 확인 (이메일·주소 숨김)
- [ ] 만료 전 2FA 있는 계정으로 도메인·플랫폼 관리 (관리자 이메일 탈취 시나리오 방어)

## 참고
- Vercel Environment Variables: https://vercel.com/docs/projects/environment-variables
- Cloudflare Free Tier: https://www.cloudflare.com/plans/free/
- Tailscale: https://tailscale.com
- Let's Encrypt: https://letsencrypt.org
