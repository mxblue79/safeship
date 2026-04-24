# 주제별 보안 가이드

`AI_CODING_SECURITY_GUIDE.md`가 전반 입문서라면, 이 폴더는 **기능별 깊이 있는 가이드**입니다. 해당 기능을 구현할 때만 읽으세요.

| 가이드 | 언제 읽나 | 핵심 리스크 |
|---|---|---|
| [01-payment-webhooks.md](./01-payment-webhooks.md) | Stripe / Toss / LemonSqueezy / PayPal 연동 시 | 결제 우회, 금액 조작, 가짜 웹훅 |
| [02-database.md](./02-database.md) | Postgres / MySQL / MongoDB / Supabase 쓸 때 | SQL Injection, IDOR, 전체 노출 |
| [03-auth-session.md](./03-auth-session.md) | 로그인 / 회원가입 구현할 때 | 세션 탈취, 비밀번호 재설정 악용 |
| [04-file-upload.md](./04-file-upload.md) | 이미지·문서 업로드 기능 만들 때 | XSS, 악성 파일, 스토리지 탈취 |
| [05-ai-llm-integration.md](./05-ai-llm-integration.md) | OpenAI / Claude / Gemini API 연동 | 프롬프트 인젝션, 청구서 폭탄 |
| [06-cors-api.md](./06-cors-api.md) | API 만들 때 / CORS 에러 뜰 때 | CSRF, 토큰 탈취 |
| [07-email-sms.md](./07-email-sms.md) | SendGrid / Twilio / 매직링크 발송 | 스푸핑, 대량 스팸 피해 |
| [08-deployment-infra.md](./08-deployment-infra.md) | Vercel / Railway / AWS 배포할 때 | 환경변수 유출, 무단 접근 |
| [09-mobile-apps.md](./09-mobile-apps.md) | React Native / Flutter / iOS / Android 개발 | 번들 내 시크릿, SSL 우회, IAP 조작 |
| [10-websocket-realtime.md](./10-websocket-realtime.md) | Socket.io / SSE / 실시간 채팅 만들 때 | 채널 엿듣기, sender 위조, rate limit |
| [11-crypto-wallet.md](./11-crypto-wallet.md) | Web3 dApp / 지갑 연동 / 스마트 컨트랙트 | 키 유출, approve 남용, reentrancy |
| [12-compliance-privacy.md](./12-compliance-privacy.md) | 사용자 개인정보 받을 때 (거의 모든 서비스) | 과징금, 스토어 리젝트, 브랜드 타격 |
| [13-incident-response.md](./13-incident-response.md) | 사고가 이미 일어났거나 의심될 때 | 시간 싸움, 증거 보존, 당국 신고 |

01~12는 공통 구조:
1. 왜 자주 터지나
2. 돈·평판 피해 실예
3. 올바른 패턴 vs 잘못된 패턴 (코드)
4. AI에게 시킬 때 프롬프트
5. 지뢰 10개
6. 머지 전 체크리스트

13번(인시던트 대응)은 시나리오별 플레이북 구조로 별도.

## 빠른 경로

"지금 이 기능 만드는 중" 기준:

- **결제 붙이는 중** → [01](./01-payment-webhooks.md) + [06](./06-cors-api.md)
- **로그인 만드는 중** → [03](./03-auth-session.md) + [07](./07-email-sms.md)
- **엑셀/이미지 받는 중** → [04](./04-file-upload.md)
- **ChatGPT 같은 챗봇 만드는 중** → [05](./05-ai-llm-integration.md)
- **실시간 채팅/협업/게임** → [10](./10-websocket-realtime.md) + [03](./03-auth-session.md)
- **모바일 앱 내는 중** → [09](./09-mobile-apps.md) + [03](./03-auth-session.md)
- **Web3 dApp** → [11](./11-crypto-wallet.md) + [03](./03-auth-session.md)
- **서비스 런칭 앞두고** → [08](./08-deployment-infra.md) + [12](./12-compliance-privacy.md) + `../AI_CODING_SECURITY_GUIDE.md` §4
- **이상 현상/유출 의심** → [13](./13-incident-response.md) 즉시
