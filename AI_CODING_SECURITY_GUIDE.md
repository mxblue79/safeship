# AI 코딩으로 서비스 만드는 사람들을 위한 보안 실전 가이드

> 대상: ChatGPT / Claude / Cursor / Copilot 등으로 직접 개발하는 1인 개발자, 사이드 프로젝트 만드는 기획자, 바이브코딩으로 상업 서비스 띄우는 사람.
> 목표: **"뭘 지시해야 할지 몰라서 보안을 놓치는"** 상황을 없애는 것.
> 읽는 데 10분. 적용하는 데 하루.

---

## 큰 그림: AI는 "시킨 것만 잘한다"

AI 코딩 도구가 만든 서비스에서 터지는 사고의 **90%는 AI의 실수가 아니라 인간의 지시 누락**입니다.

- AI: "로그인 만들어줘" → 동작하는 로그인 만듦. 권한 체크는 안 함 (안 시켰으니까).
- AI: "결제 붙여줘" → 결제 UI 만듦. 서명 검증은 안 함 (모르니까).
- AI: "관리자 페이지 만들어줘" → 관리자 페이지 만듦. 권한 게이트 없음 (프론트만 `if (isAdmin)`).

**"AI가 보안을 생각해서 만들었겠지"는 오해입니다.** 당신이 명시적으로 지시하지 않으면 AI는 최소 동작 코드만 생성합니다.

---

## 0. AI 시키기 전 — 절대 몰라서는 안 될 3가지

가장 큰 사고는 코드가 아니라 **GitHub/환경변수를 잘못 이해한 상태**에서 납니다. 이 섹션부터 이해 안 되면 뒤는 읽어도 소용없어요.

### 0.1 "git push"는 백업이 아니라 공유입니다

초보자가 가장 오해하는 것: "**GitHub는 내 코드 백업용 클라우드**"라는 인식.

실제로는:
- **Public 레포**: 전 세계 누구나 `https://github.com/내이름/레포명`에 들어가 **전체 히스토리를 포함한 모든 코드를 실시간으로 조회** 가능. 검색엔진·Google·ChatGPT 학습 데이터에까지 들어갑니다.
- **Private 레포**: 내가 초대한 사람 + GitHub 직원만 조회 가능. 실용상 안전.

**가장 자주 일어나는 사고 패턴**:

1. 학습·튜토리얼 단계에서 아무 생각 없이 Public으로 레포 생성 → 습관이 됨.
2. 그 레포 그대로 상업 서비스로 성장시킴 → 여전히 Public.
3. 개발 중 `.env`를 한 번 실수로 커밋 → 분 단위로 봇이 탈취.
4. 개발자는 "그 커밋 삭제했는데요?"라고 생각하지만, 과거 커밋은 영원히 남음.

**원칙**:
- **상업 프로젝트, 실제 사용자가 있는 서비스는 무조건 Private이 기본**.
- Public은 "지금 당장 HackerNews 1면에 올라가도 문제없는 **의도된 오픈소스**"일 때만.
- 확인: GitHub 레포 페이지 상단에 `Public`이라 쓰여 있나요? 상업 프로젝트라면 **Settings → General → 맨 아래 "Change repository visibility" → Private**.

### 0.2 시크릿은 Public/Private **무관하게** git에 올리면 안 됩니다

**이게 진짜 핵심입니다.** "내 레포 Private이니까 .env 커밋해도 괜찮겠지" — 위험한 착각입니다.

Private 레포라도 `.env`를 커밋하면 터지는 경로:
- 협업자·외주 개발자 초대 순간 → 전부 조회 가능 (해고/이탈해도 fork/clone본 남음)
- 실수로 Public 전환 시 → 전체 히스토리 즉시 공개
- `.git` 폴더가 포함된 채 Vercel/Netlify/정적 호스팅에 업로드 → 공격자가 `.git/config` 탐색으로 복원
- 훗날 오픈소스화할 때 → 히스토리 정리 지옥 (BFG 돌려도 포크본은 못 회수)

**원칙: 시크릿(.env, API 키, DB 비밀번호, 인증서)은 어떤 상황에도 git에 안 들어갑니다.** 이건 Public/Private과 **무관한 별개의 원칙**입니다.

올바른 위치:
- 개발 중: `.env` 파일 (로컬에만 존재, `.gitignore`에 추가)
- 배포: Vercel/Railway/AWS 콘솔의 **환경변수 UI**에 값을 직접 붙여넣기 (파일 업로드 X)
- 팀 공유: 1Password / Bitwarden / Doppler 같은 비밀 관리 툴

### 0.3 지금 당장 30초 체크

**① 레포 공개 여부**
```
GitHub 내 레포 상단 → Public / Private 확인
상업 프로젝트인데 Public이면 → Settings → Change visibility → Private
```

**② `.gitignore`에 시크릿 패턴 포함**
```bash
# 프로젝트 루트에서 확인
cat .gitignore | grep -E "\\.env|\\.key|secrets"
```
최소 아래는 있어야 함:
```
.env
.env.*
!.env.example
*.pem
*.key
secrets/
```

**③ 이미 커밋된 시크릿 점검 (중요)**
```bash
# git이 추적 중인 시크릿 파일
git ls-files | grep -E "\\.env$|\\.key$|secret"

# 히스토리 전체 스캔 (gitleaks 설치: https://github.com/gitleaks/gitleaks)
gitleaks detect --source . --no-banner
```

**하나라도 나오면 순서대로**:
1. **즉시 해당 키 로테이션** (새 키 발급 + 기존 키 폐기). 가장 먼저. 로테이션 없이 히스토리만 정리하면 의미 없음 — 이미 유출된 키는 이미 유출된 키입니다.
2. `git rm --cached <파일>` + `.gitignore` 추가 + 커밋.
3. 히스토리 정리: [BFG Repo-Cleaner](https://rtyley.github.io/bfg-repo-cleaner/).
4. `git push --force` (협업자에게 사전 공지).

**절대 안 됨**: "삭제 커밋 하나 추가"로 덮기 — 과거 커밋은 그대로 남아 여전히 조회됩니다.

---

## 1. 프로젝트 시작할 때 — AI에게 한 번만 시키는 것

새 프로젝트 첫 대화에서 아래 문장을 **그대로 붙여넣으세요.** 이 지시가 시스템 프롬프트처럼 작동해서 이후 생성되는 코드의 보안 수준을 크게 끌어올립니다.

````
이 프로젝트는 상용 서비스로 배포될 예정이야. 앞으로 작성하는 모든 코드에 아래 규칙을 기본 적용해줘:

1. 모든 API 엔드포인트는 서버 측에서 권한 체크. 프론트엔드에서만 숨기지 말 것.
2. user_id / tenant_id / role 은 절대 클라이언트 body에서 받지 않음.
   인증된 세션/토큰에서 꺼내서 써.
3. 모든 외부 입력(URL, 파일, 텍스트)은 서버에서 검증. 프론트 검증은 UX용일 뿐.
4. 시크릿(.env, API 키)은 `NEXT_PUBLIC_` / 클라이언트 번들에 절대 포함 금지.
5. 결제·웹훅은 반드시 서명 검증 + 금액 재조회 + 멱등성(중복 방지).
6. 비밀번호는 bcrypt/argon2. 세션 쿠키는 HttpOnly + Secure + SameSite.
7. SQL은 항상 파라미터 바인딩. 문자열 연결 금지.
8. 파일 업로드는 MIME 타입 + 크기 + 확장자 화이트리스트. SVG 허용 금지.
9. 로그인/결제/비밀번호 재설정 등 민감 엔드포인트는 rate limit.
10. 에러 응답에 스택 트레이스·쿼리·환경변수 누설 금지.

위 규칙을 어길 수밖에 없는 상황이 오면 **먼저 나에게 물어봐.** 임의로 타협하지 말 것.
````

이것만 해도 초기 생성 코드가 훨씬 안전해집니다.

---

## 1.5 API 키·시크릿이 뭔지 먼저 이해 (초보자 필독)

AI 코딩 하다 보면 "OpenAI API 붙이자", "Stripe 결제 연동하자" 같은 상황이 자주 나옵니다. 그때마다 나오는 **"API 키"**가 뭔지 명확히 모르면 이 섹션 꼭 읽으세요.

### API 키란?

외부 서비스(OpenAI·Stripe·SendGrid·Supabase·AWS 등) 계정의 **비밀번호 대체품**입니다.

이 키가 유출되면 실제로 벌어지는 일:
- **OpenAI 키 유출**: 공격자가 내 계정으로 GPT-4 무한 호출 → **24시간 안에 수백만원 청구서**
- **Stripe 키 유출**: 내 계좌에 가짜 환불 트리거, 카드 정보 조회
- **AWS 키 유출**: 암호화폐 채굴 인스턴스 수십 대 기동 → **하룻밤에 수천만원**
- **Supabase `service_role` 키 유출**: RLS 무시하고 DB 전체 읽기/삭제 가능
- **SendGrid 키 유출**: 내 도메인으로 피싱 메일 대량 발송 → 도메인 스팸 블랙리스트

실제로 GitHub에 올라간 AWS 키가 **30초 안에** 탈취되어 수천만원 피해를 입은 사례는 매년 수십 건씩 공식 집계됩니다.

### API 키는 어디서 써야 하나?

**오직 서버 코드에서만.**

올바른 흐름:
```
[사용자 브라우저] → [내 백엔드 서버] → [OpenAI API]
                      ↑
                      .env의 OPENAI_API_KEY 읽어서 여기서 호출
```

잘못된 흐름 (초보자가 흔히 만드는 구조):
```
[사용자 브라우저] → [OpenAI API]
      ↑
      코드에 키 포함 → F12로 누구나 추출 가능
```

### 어디다 보관하고 어디서 못 쓰는지

✅ **보관 가능한 곳**:
- 로컬 개발: `.env` 파일 (반드시 `.gitignore`에 추가)
- 배포: Vercel / Railway / AWS 콘솔의 **환경변수 설정 UI**에 값을 붙여넣기
- 팀 공유: 1Password, Bitwarden, Doppler 같은 비밀 관리 툴

❌ **넣으면 안 되는 곳** (각각이 실제 사고 사례):
- 프론트엔드 코드 (`.tsx`, `.vue`, `.svelte`) — F12로 노출
- 모바일 앱 코드 (Android APK / iOS IPA) — 디컴파일로 추출
- git 커밋 — 과거 커밋까지 영구 보존
- `README.md` 예제 섹션 — "이 문서 참고하세요" 하면서 Slack에서 확산
- Slack / Discord / 카톡 — 스크린샷 유출
- ChatGPT / Claude 프롬프트 — LLM에 붙여넣는 순간 외부 서버로 전송 (데이터 학습 미사용이어도 유출로 간주)
- Notion / 구글 독스 — 공유 링크가 "누구나 링크로" 열려 있으면 검색 노출

### Next.js 특수: `NEXT_PUBLIC_` 접두사를 반드시 이해하세요

Next.js는 환경변수에 `NEXT_PUBLIC_` 접두사가 붙으면 **브라우저 번들에 포함**시킵니다 = 전 세계 공개.

```bash
# ✅ 서버 전용 (안전)
OPENAI_API_KEY=sk-xxxxxxxxxx

# ❌ 브라우저에 노출 (치명적)
NEXT_PUBLIC_OPENAI_API_KEY=sk-xxxxxxxxxx
```

왜 이런 게 존재하나? 정말로 공개해도 되는 값(예: Google Analytics ID, 공개 지도 API 키)만 쓰라고 만든 겁니다.

**규칙**:
- 시크릿에 `NEXT_PUBLIC_` 붙이는 건 **"현관 매트 밑에 집 열쇠 두는 것과 같다"**.
- AI가 `NEXT_PUBLIC_DATABASE_URL=...` 같은 코드를 생성하면 **무조건 거부하고 고쳐달라고 해야 합니다.**
- 유사 프레임워크들도 규칙 있음 — Vite는 `VITE_*`, Create React App은 `REACT_APP_*`. 모두 "공개됨"이라는 뜻.

### 서버 없이 프론트만 있는 프로젝트인데 OpenAI 호출하고 싶으면?

**최소한의 프록시 서버라도 반드시 필요합니다.** 선택지:

1. **Next.js Route Handler** (`app/api/chat/route.ts`) — 풀스택 프로젝트면 제일 쉬움
2. **Vercel / Netlify Functions** — 정적 호스팅이어도 서버리스 함수 하나만 추가
3. **Supabase Edge Functions** — Supabase 쓰면 이미 무료 포함
4. **Cloudflare Workers** — 무료 티어 후함

"프론트만으로 MVP 빨리 만들려고 키를 클라이언트에 두자" — **절대 안 됩니다.** MVP라도 유출되는 순간 실제 금전 피해가 발생합니다.

### AI에게 API 키 관련 작업 시킬 때 덧붙일 문장

````
OpenAI/Stripe/Supabase 등 외부 API 키를 쓰는 코드를 작성할 때는 다음 규칙을 지켜:

1. 키는 절대 프론트엔드 코드나 모바일 앱 번들에 포함시키지 않기.
2. Next.js에서 NEXT_PUBLIC_ 접두사는 시크릿에 절대 사용하지 않기.
3. 프론트에서 외부 API를 호출해야 하면 반드시 내 서버(Route Handler/
   서버리스 함수)를 경유해서 호출하는 구조로 만들기.
4. .env 예시 파일(.env.example)에는 빈 값만 넣고, 실제 값은 .env에만 넣고
   .gitignore 포함 확인하기.
5. README나 코드 주석에 실제 키 값 예시로 쓰지 말기.
````

---

## 2. 기능별 "AI에게 덧붙일 한 줄"

기능을 요청할 때 아래 문구를 **한 줄만** 추가하면 AI가 해당 기능의 전형적 함정을 스스로 피합니다.

| 기능 요청 | 덧붙일 문장 |
|---|---|
| **로그인/회원가입** | "이메일 열거 공격 방지하고, brute force rate limit 걸고, 비밀번호는 bcrypt로." |
| **비밀번호 재설정** | "토큰은 1회용 + 15분 만료. 재설정 후 모든 기존 세션 무효화." |
| **파일 업로드** | "MIME + 확장자 + 크기 화이트리스트 적용하고 파일명 sanitize. SVG·exe 거부." |
| **결제 통합** | "웹훅은 서명 검증 + 금액 서버에서 재조회 + order_id로 멱등성 보장." |
| **관리자 페이지** | "권한 체크는 서버 미들웨어에서. 프론트 if 문은 UX용으로만 믿어." |
| **리소스 조회 (`GET /api/posts/:id`)** | "요청자가 이 리소스의 소유자인지 서버에서 확인. IDOR 방지." |
| **사용자 입력 HTML 렌더** | "dangerouslySetInnerHTML 쓸 거면 DOMPurify로 sanitize. 그냥 렌더 안 돼." |
| **외부 URL 입력 받음** | "스킴은 http/https만 허용. javascript: 같은 건 거부. url.Parse로 검증." |
| **이메일 발송** | "수신자 필드에 \\r\\n 차단. 템플릿에 사용자 입력 들어가면 이스케이프." |
| **검색/필터** | "SQL 파라미터 바인딩 사용. LIKE 쓸 때 %, _ 이스케이프." |

---

## 3. AI가 코드 썼으면 바로 물어볼 5가지 질문

AI가 기능을 완성했다고 말하면 **다음 세션 or 같은 세션에서** 아래 프롬프트를 복붙하세요.

````
방금 네가 쓴 코드에 대해 보안 점검 해줘. 다음 질문에 각각 구체적 근거(파일:라인)로 답해:

1. 이 기능에 인증이 필요한데, 서버 측 권한 체크가 어디에 있어?
   (프론트 if 문은 답이 아님. 백엔드 미들웨어/핸들러 진입부.)
2. 클라이언트 body에서 받는 값 중 권한/소유권 결정에 쓰이는 게 있어?
   있으면 전부 세션/토큰에서 꺼내도록 바꿔.
3. 외부 입력(URL, 파일, 텍스트, JSON)을 서버에서 어떻게 검증해?
4. 응답에 필요 이상의 정보(이메일, 해시, 원본 데이터, 내부 ID) 안 새나가?
5. 실패 시 에러 메시지에 스택 트레이스·쿼리·환경변수 안 드러나?

문제 있으면 "문제 X: 파일:라인 — 공격 시나리오 — 수정" 형식으로 보고하고
없으면 "없음"이라고 명시해. 이론적 위험은 제외, 실제 악용 가능한 것만.
````

**중요**: AI는 "괜찮아 보여요" 같은 막연한 응답을 내는 경향이 있습니다. **구체적 근거(파일:라인)를 강제**하면 정직해집니다.

---

## 4. 배포 전 5분 체크 (사람이 직접)

AI에게 맡기지 말고 **당신이 직접** 확인할 것들. 익숙해지면 3분.

### ① `.env` 노출 확인
```bash
git ls-files | grep -E "\\.env$"
# 결과: 아무것도 안 나와야 함. 나오면 즉시 git rm --cached + .gitignore 추가
```

### ② 시크릿 스캔
```bash
# 설치: brew install gitleaks  (macOS) 또는 https://github.com/gitleaks/gitleaks
gitleaks detect --source . --no-banner
```
`sk_live_*`, `AKIA*`, 긴 문자열이 검출되면 → 지금 당장 **키 로테이션** + 커밋 히스토리에서 제거 (BFG Repo-Cleaner).

### ③ 클라이언트 번들에 시크릿 없는지 (Next.js)
```bash
# 빌드 후
grep -rE "service_role|sk_live|SECRET_KEY" .next/static/ 2>/dev/null
# 결과: 아무것도 안 나와야 함
```

### ④ 배포된 URL의 보안 헤더
```bash
curl -sI https://your-domain.com/ | grep -iE "content-security|x-frame|x-content-type|strict-transport"
```
4개 다 나와야 정상. 안 나오면 `next.config.js`에 `headers()` 추가.

### ⑤ 로그인 없이 민감 엔드포인트 호출해보기
```bash
# 예: /api/admin/users 같은 걸 쿠키 없이 호출
curl -s https://your-domain.com/api/admin/users
# 결과: 401/403이어야 함. 200 뜨면 권한 누락. 즉시 배포 롤백.
```

---

## 5. "바이브코더 지뢰 16개" — 흔한 실수 실제 사례

실제로 터진 사고 패턴. AI가 **자주 만드는** 코드이기도 합니다.

### ① 프론트에서만 권한 체크
```tsx
// ❌ AI가 자주 생성하는 것
{user.isAdmin && <DeleteButton />}
// 백엔드 API는 무방비. 공격자가 직접 API 호출하면 아무나 삭제 가능.
```
**AI에게**: "서버 API 진입부에 권한 미들웨어 붙여줘. UI는 UX용."

### ② 클라이언트가 `user_id` 보냄
```js
// ❌ 위험
app.post('/posts', (req, res) => {
  db.insert({ user_id: req.body.user_id, content: req.body.content })
})
// 공격자가 user_id 바꿔서 다른 사람 이름으로 글 올림.
```
**AI에게**: "user_id는 req.body에서 받지 말고 인증된 세션에서 꺼내."

### ③ `NEXT_PUBLIC_` 에 시크릿
```
NEXT_PUBLIC_SUPABASE_SERVICE_ROLE=eyJhbG...
# 빌드되면 브라우저 번들에 포함. 누구나 F12로 볼 수 있음.
```
**AI에게**: "`service_role` 키는 서버 전용. `NEXT_PUBLIC_` 접두사 금지."

### ④ 결제 성공 여부를 프론트가 판정
```js
// ❌ 사용자가 결제 후 프론트에서 "success" 확인하고 DB에 업데이트 요청
if (paymentResult === 'success') {
  await fetch('/api/unlock-premium', { method: 'POST' })
}
// 공격자가 DevTools에서 직접 POST 호출하면 무료로 프리미엄.
```
**AI에게**: "결제 확정은 반드시 서버가 PG사 웹훅 + API 재조회로 검증."

### ⑤ OAuth redirect에 와일드카드
```
Allowed Redirects: https://my-app.com/*
# *만 있으면 https://my-app.com/../../attacker.com 같이 우회 가능
```
**AI에게**: "redirect URI는 정확한 경로로 고정. 와일드카드 금지."

### ⑥ Supabase RLS 안 켬
```sql
-- ❌ ENABLE ROW LEVEL SECURITY 없이 테이블 생성
CREATE TABLE posts (...);
-- anon 키로 SELECT 하면 전체 데이터 보임.
```
**AI에게**: "모든 테이블에 RLS 켜고, SELECT/INSERT/UPDATE/DELETE 각각 정책 작성."

### ⑦ 에러 응답에 내부 정보 노출
```json
{ "error": "Database error: SELECT * FROM users WHERE email = 'x' — pg_error: ..." }
```
**AI에게**: "에러 응답은 사용자용 메시지만. 상세는 서버 로그로."

### ⑧ 비밀번호를 URL 쿼리로
```
GET /reset?password=newpass123
// Referer, 프록시 로그, 브라우저 히스토리에 남음.
```
**AI에게**: "비밀번호/토큰은 절대 URL 쿼리 아니라 POST body 또는 헤더로."

### ⑨ 파일 업로드에 SVG 허용
```
accept="image/*"
// SVG 안에 <script> 넣어 업로드 → 미리보기 하면 XSS.
```
**AI에게**: "SVG 업로드 금지. PNG/JPG/WEBP만 허용."

### ⑩ AI가 만든 "임시 테스트 코드"가 배포에 살아있음
```js
// FIXME: 테스트용 - 배포 전 제거
if (email === 'admin@test.com') return { role: 'admin' }
```
**AI에게**: "TODO/FIXME 달린 보안 관련 코드는 머지 전 반드시 제거."

### ⑪ 상업 프로젝트인데 레포가 Public
```
github.com/myname/my-saas   ← Public 아이콘 달려 있음
```
학습 단계의 습관으로 Public 생성 → 그대로 상업 서비스화. 실수 한 번이면 전 세계 공개.

**조치**: Settings → Change visibility → Private. 지금 바로.

### ⑫ API 키를 프론트에서 직접 호출
```tsx
// ❌ 브라우저에서 OpenAI 직접 호출
const res = await fetch('https://api.openai.com/v1/chat/completions', {
  headers: { 'Authorization': `Bearer ${OPENAI_KEY}` }  // F12로 누출
})
```
**AI에게**: "외부 API 호출은 내 서버(Next.js Route Handler, 서버리스 함수)를 경유하는 구조로 만들어. 키는 서버에서만 읽어."

### ⑬ `.env`가 이미 커밋돼 있는데 "지금부터 `.gitignore`에 추가하면 되겠지"
```bash
# ❌ 잘못된 순서
echo ".env" >> .gitignore
git add .gitignore && git commit -m "ignore env"
# 과거 커밋의 .env는 그대로 히스토리에 남음. 봇은 이미 스캔 완료.
```
**올바른 순서**:
1. **키 로테이션 먼저** (유출된 키를 폐기, 새 키 발급)
2. `git rm --cached .env` + `.gitignore` 등록
3. BFG Repo-Cleaner로 히스토리 정리 + 강제 푸시

### ⑭ ChatGPT/Claude에 디버깅 요청하면서 `.env` 전체 붙여넣기
```
"이 에러 좀 봐줘"
[.env 전체 복붙]
"OPENAI_API_KEY=sk-proj-xxxxxxxx..."
```
LLM 서비스의 데이터 정책과 무관하게 **외부 서버로 전송된 시점에 유출로 간주**합니다. 네트워크 캡처, 로그 보존, 사람 리뷰 등 유출 경로가 다양.

**AI에게**: "디버깅 도와줘. 단, .env나 실제 키 값은 공유 안 함 — KEY=<redacted> 형식으로만 보여줄게."

### ⑮ 관리자 도구가 공개 URL로 열려있음
```
Prisma Studio: http://your-app.com:5555 (인증 없음)
pgAdmin: http://your-app.com/pgadmin (기본 admin/admin)
Supabase Studio: 로컬 포트 공개 노출
```
AI가 개발 편의로 열어둔 그대로 배포됨. 공격자가 포트 스캐너로 발견.

**AI에게**: "관리자·관측 도구는 프로덕션에서 인증 없이 공개 URL로 노출되지 않게. VPN·IP allowlist·별도 인증 필수."

### ⑯ `git push --force`로 협업자 작업 날림
AI가 "히스토리가 지저분해서 정리하겠습니다" 하고 `--force` 제안하는 경우 있음.
팀원 작업이 사라지고, 시크릿 유출 사고에서도 오히려 증거 인멸로 보일 수 있음.

**AI에게**: "force push는 절대 제안하지 마. 히스토리 변경이 필요하면 상세히 이유 설명하고 나에게 먼저 확인받아."

---

## 6. 도움 받을 수 있는 자동화 도구

사람이 다 볼 수 없으니 도구가 1차로 걸러줍니다. 다만 **뭘·언제 써야 하는지** 헷갈리는 게 진짜 문제라서, 이 섹션이 그 지도입니다.

### 도입 우선순위 (솔로 개발자 기준)

| 순서 | 도구 | 시점 | 세팅 시간 | 막히는 사고 |
|---|---|---|---|---|
| 1 | gitleaks (pre-commit) | 첫 커밋 전 | 5분 | 시크릿이 git에 올라가는 순간 |
| 2 | Dependabot | GitHub 레포 만든 직후 | 2분 | 취약 라이브러리 방치 |
| 3 | Sentry | 배포 첫날 | 30분 | 에러를 나만 모르는 상황 |
| 4 | Cloudflare | 도메인 연결할 때 | 30분 | DDoS·봇 공격 |
| 5 | Uptime 모니터링 | 프로덕션 운영 시작 | 5분 | 자는 동안 서비스 다운 |
| 6 | safeship (이 CLI) | 배포 직전 + 주 1회 | 5분 | 프레임워크 특화 함정, 헤더 회귀 |

**"이걸 다 해야 하나?"** — 처음 **3개만** 해도 가장 큰 사고 세 가지(시크릿 유출, CVE 취약점, 에러 무인지)를 막습니다. 나머지는 실사용자 생긴 뒤에 얹어도 됩니다.

---

### 🔑 gitleaks — "커밋한 코드에 API 키 들어갔나?"

**이게 필요한 순간**: 지금. 모든 프로젝트, 첫 커밋 전. AI 코드 생성물에 가장 많이 섞여 들어오는 실수가 시크릿 하드코딩이라서.

**뭐하는 도구**: 코드·git 히스토리를 스캔해서 AWS 키(`AKIA...`), Stripe 키(`sk_live_...`), OpenAI 키(`sk-proj-...`), GitHub 토큰 같은 **시크릿 패턴 수백 개**를 정규식으로 찾아냅니다.

**두 가지 사용 방식** — **(2)가 진짜 목적**:
1. 일회성 검사: 과거 커밋 점검
2. **pre-commit hook**: 커밋하려는 순간 자동 검사, 시크릿 발견 시 커밋 거부 → 실수 자체가 불가능해짐

**설치**:
```bash
# macOS
brew install gitleaks

# Windows (여기가 많이 헤맴)
# https://github.com/gitleaks/gitleaks/releases 에서 zip 다운
# 압축 풀고 gitleaks.exe를 PATH에 포함된 폴더로 복사
# PowerShell에서 gitleaks version 실행되면 OK

# Linux
curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.18.0/gitleaks_8.18.0_linux_x64.tar.gz | tar -xz
sudo mv gitleaks /usr/local/bin/
```

**일회성 검사**:
```bash
cd my-project
gitleaks detect --source . --no-banner
```

결과 예시:
```
Finding:     AKIAIOSFODNN7EXAMPLE
File:        .env
Line:        3
Rule:        aws-access-token
```

→ **즉시 해당 키 로테이션** (§0 참조). 히스토리 정리는 그 다음.

**Pre-commit hook 세팅** (커밋 자동 차단):
```bash
# 프로젝트 루트에 .pre-commit-config.yaml
cat > .pre-commit-config.yaml << 'EOF'
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.0
    hooks:
      - id: gitleaks
EOF

# pre-commit 설치
brew install pre-commit      # macOS
pip install pre-commit       # 공통
pre-commit install            # 이 레포에 훅 활성화
```

이후 `.env` 실수로 `git add`해도 커밋 시점에 차단됩니다. **이 세팅 한 번이 평생 사고 방어**.

**false positive 자주 겪는 것**:
- 테스트용 목업 키(`sk_test_dummy`) → `.gitleaksignore`에 특정 파일 제외
- 외부 라이브러리 예제 문자열 → 동일하게 제외
- GitHub Personal Access Token 형태와 우연히 겹치는 긴 hash → 커밋 메시지에 `#skip-secret-check` 같은 우회 태그

---

### 📦 npm audit / govulncheck — "내 라이브러리에 취약점 있나?"

**이게 필요한 순간**: 프로젝트 시작 직후 + 매주 금요일 15분.

**뭐하는 도구**: 내가 쓰는 라이브러리가 **알려진 취약점(CVE) 목록에 있는지** 비교. 예: "lodash 4.17.20 → prototype pollution 취약, 4.17.21로 올려".

**왜 이게 보안 이슈인가**: 내 코드가 아무리 안전해도 **의존성의 버그는 그대로 내 서비스에 들어옵니다.** 2021 log4j 사태가 대표 예 — log4j 한 줄 쓴 전 세계 서버가 동시에 RCE 취약점에 노출됐음. 내가 안 쓴 것 같아도 다른 라이브러리가 의존하고 있는 경우도 많음.

**Node.js / npm**:
```bash
npm audit
# high 이상만 보기
npm audit --audit-level=high

# 자동 패치 시도 (minor/patch까지만)
npm audit fix

# major 업그레이드까지 시도 — 주의, breaking change 가능
npm audit fix --force
```

**Go**:
```bash
go install golang.org/x/vuln/cmd/govulncheck@latest
govulncheck ./...
# 실제로 해당 취약 함수를 호출하는지까지 체크해줌 (false positive 적음)
```

**Python**:
```bash
pip install pip-audit
pip-audit
```

**결과 해석 가이드**:
- **critical / high**: 프로덕션 `dependencies`에 있으면 **즉시** 패치
- **high가 devDependencies**에만: 덜 급함 (빌드 시에만 영향). 하지만 CI 빌드 서버가 공격 대상이면 여전히 위험
- **moderate / low**: 주간 루틴에 포함. 당장은 괜찮음

**자주 겪는 실수**:
- "매번 나오는 똑같은 high, 무시" → 무시하면 쌓임. 일주일에 한 번 fix 돌리는 루틴 필수
- `--force`로 고쳤더니 앱이 안 돎 → major 업그레이드 breaking change. 한 패키지씩 수동 업그레이드 + 테스트
- AI가 `"overrides"` 필드로 억지로 패치 → 동작은 하는데 실제 버전이 달라 예상 밖 버그. 가능하면 정상 업그레이드 우선

---

### 🤖 Dependabot — "취약점 나올 때마다 자동으로 PR 받기"

**이게 필요한 순간**: GitHub 레포 만든 다음 5분 안에. 설정 파일 한 개로 끝.

**뭐하는 도구**: GitHub이 매주 내 `package.json`·`go.mod`·`requirements.txt`를 스캔, 취약점·업데이트가 나오면 **자동으로 PR을 생성**합니다. 내가 할 일은 PR을 보고 병합할지 결정하는 것뿐.

**왜 `npm audit`보다 강한가**: `npm audit`는 **내가 직접 돌려야** 함 → 안 돌림. Dependabot은 **알아서 PR 찔러줌** → 무시하기 어려움.

**세팅**:
```yaml
# .github/dependabot.yml
version: 2
updates:
  # npm
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5

  # GitHub Actions 워크플로우 버전도 추적
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

커밋하고 푸시하면 며칠 안에 첫 PR이 뜹니다.

**PR 병합 기준**:
- **Patch (`1.2.3 → 1.2.4`)**: 대부분 버그 픽스. 눈 감고 병합해도 보통 안전
- **Minor (`1.2.3 → 1.3.0`)**: changelog 한 줄씩 훑어보고 병합
- **Major (`1.2.3 → 2.0.0`)**: breaking change 예고. CI 통과하면 병합, 실패하면 수동 작업

**자주 겪는 실수**: PR이 20개 쌓여도 "이따가 보지"로 방치 → 1년 후 마이그레이션 지옥. **매주 금요일 오후 15분 루틴**으로 박아두기.

**팁**: Auto-merge 설정하면 minor·patch는 CI 통과 시 자동 병합. 솔로 개발자에게 특히 편함:
```yaml
# dependabot.yml
- package-ecosystem: "npm"
  directory: "/"
  schedule: { interval: "weekly" }
  # 아래 labels + GitHub 액션으로 auto-merge 트리거
  labels: ["dependencies", "auto-merge"]
```

---

### 🚨 Sentry — "사용자가 에러 겪었는데 나는 모르는 상황"

**이게 필요한 순간**: 첫 실사용자 생긴 순간. "내가 테스트한 건 잘 되는데 왜 사용자는 안 된다고 할까?"의 답이 여기.

**뭐하는 도구**: 프로덕션에서 난 에러를 **실시간으로 수집**해서 대시보드·Slack·이메일로 알려줌. "사용자 X가 결제 중 TypeError 떴다"를 **실제로 일어난 30초 뒤** 내가 알 수 있음.

**왜 이게 보안 이슈인가**:
1. 사용자는 에러 나면 **조용히 떠납니다.** CS 넣어주길 기다리면 이미 100명은 이탈한 뒤.
2. 보안 이슈의 첫 징후는 **설명 불가능한 에러**로 나타나는 경우가 많음. SQL Injection 시도는 쿼리 파싱 에러로, 권한 우회 시도는 403/500으로.

**세팅 (Next.js)**:
```bash
npx @sentry/wizard@latest -i nextjs
# 대화형으로 프로젝트 생성 + 설정 자동 주입됨
```

**PII 마스킹 (필수)**:
```ts
// sentry.client.config.ts
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  beforeSend(event) {
    // 쿠키·Authorization 헤더 제거 → 세션 토큰 유출 방지
    if (event.request?.headers) {
      delete event.request.headers['authorization']
      delete event.request.headers['cookie']
    }
    // 이메일·전화번호 포함된 context도 마스킹
    if (event.user?.email) event.user.email = '[redacted]'
    return event
  },
  tracesSampleRate: 0.1,  // 전체 트래픽 샘플링 10% (비용 관리)
})
```

**알림 연결 (이걸 안 하면 의미 없음)**:
- Settings → Alerts → 새 규칙: "새 에러 발생 시 Slack #alerts 채널로"
- 또는 이메일. 모바일 앱 깔면 푸시 알림도 가능

**무료 한도**: 월 5천 이벤트, 스택 트레이스 보관 30일. 소규모 서비스 충분.

**자주 겪는 실수**: 설치만 하고 알림 안 켬 → 대시보드만 에러 쌓임 → 내가 열어볼 때까지 모름. **Slack integration 필수**.

---

### 🛡️ Cloudflare — "봇·DDoS로 서비스 느려지는 거 막기"

**이게 필요한 순간**: 도메인 구매하고 DNS 설정할 때 바로. 나중에 붙이려면 네임서버 변경 기다림으로 서비스 다운 타임 감수해야 함.

**뭐하는 도구**: CDN + DDoS 방어 + WAF(웹 방화벽) + 봇 차단 + SSL이 **한 번에**. DNS를 Cloudflare에 위탁하면 전 세계 트래픽이 Cloudflare를 거쳐 내 서버로 옴 → 악의 트래픽은 여기서 걸러짐.

**무료 티어만으로도 얻는 것**:
- DDoS 보호 (무제한 규모)
- SSL 인증서 자동
- Bot Fight Mode (단순 스크래퍼·크롤러 차단)
- Rate Limiting Rule 10개 (예: "로그인 엔드포인트에 분당 10회 초과 시 차단")
- Firewall Rule 5개 (국가/IP/User-Agent 차단)

**세팅 요약**:
1. Cloudflare 가입, Add Site → 내 도메인 입력
2. 도메인 등록처(가비아 등)에서 네임서버를 Cloudflare가 준 2개로 변경
3. 전파 대기 (보통 1-24시간)
4. DNS 레코드 확인 → **주황 구름이 ON**인지 (프록시 경유)
5. SSL/TLS → **Full (strict)** 선택 — 가장 안전
6. Security → Bot Fight Mode **활성**
7. (선택) Security → WAF → Rate Limiting 규칙 추가

**언제 불필요한가**:
- B2B SaaS, 사용자가 지정 IP에서만 접속 → 자체 방화벽이 더 정밀
- Vercel/Railway 자체 DDoS 방어로 충분한 소규모 사이드 프로젝트 → 초기 생략 가능. 사용자 1000명 넘으면 고려

**주의**: Cloudflare로 전환 시 **메일 발송 설정**(SPF, DKIM, MX) 꼭 재확인. DNS 옮기면서 누락되면 회원가입 메일이 스팸함 행 → 며칠 모르다가 발견하는 흔한 실수.

---

### 🟢 Uptime 모니터링 — "서비스 다운됐는데 나는 자고 있음"

**이게 필요한 순간**: 프로덕션 배포 직후. 밤에 자는데 서버 내려가면 아침까지 아무도 못 씀.

**추천 도구 (무료 티어)**:
- [Better Stack](https://betterstack.com) — 3분 체크 10개 무료, 예쁜 public status 페이지까지 자동 생성
- [UptimeRobot](https://uptimerobot.com) — 5분 체크 50개 무료
- [Cron-Job.org](https://cron-job.org) — 가벼운 HTTP 체크만 필요할 때

**세팅 (Better Stack 예시, 5분)**:
1. 가입
2. Monitors → New monitor → 내 도메인 URL 입력
3. Alert channels에 이메일 + Slack + (유료는 SMS·전화) 연결
4. Down 감지 시 **1분 내 알림**

**보안과의 관계**: 다운 감지는 **"서비스가 죽었다"** 만 알려주는 게 아님. 갑작스런 응답 시간 급증은 DDoS·크롤러 공격의 첫 징후. Status 추이 지켜보는 것만으로도 많은 공격을 초기에 포착.

**자주 겪는 실수**: 알림을 이메일 하나로만 걸어두고 **이메일 앱이 방해금지 모드** → 새벽에 못 봄. Slack·SMS·전화 중 하나는 반드시 "절대 무시 못 하는 채널"로.

---

### 🔬 safeship (이 CLI) — "배포 직전 마지막 스냅샷"

**이게 필요한 순간**: 첫 배포 직전 + 배포 후 주 1회.

**뭐하는 도구**: 위 도구들의 커버리지를 보완하는 **프레임워크 특화** 정적 분석 + 배포 URL 헤더 스캐너. 특히:
- Next.js `NEXT_PUBLIC_*`에 `service_role`·`SECRET` 들어갔는지
- Supabase 테이블에 RLS 누락됐는지
- API 라우트에 인증 미들웨어 없는지
- 배포된 사이트에 HSTS·CSP·X-Frame-Options 헤더 있는지

```bash
# 정적 분석
node safeship.js static .

# 배포된 URL 헤더 체크
node safeship.js http https://my-domain.com

# JSON 출력 (CI 파이프라인용)
node safeship.js static . --json > report.json
```

**다른 도구와 관계**: gitleaks를 대체하지 않음 — **병행** 사용. gitleaks가 시크릿 전담, safeship은 구조·설정·헤더 전담.

---

### 🔍 선택 도구 (팀 커지거나 컴플라이언스 필요할 때)

솔로 개발자·소규모 팀은 아래 없이도 운영 가능. 필요해지는 시점까지 도입 미루세요.

- **[Snyk](https://snyk.io)** — npm audit 확장판. DB가 더 크고 컨테이너·IaC(Terraform 등)도 스캔. 개인 무료 티어.
- **[Semgrep](https://semgrep.dev)** — 코드 패턴 룰 기반 SAST. 커스텀 룰 작성해서 "우리 팀은 이런 패턴 금지" 강제. 무료 티어 후함.
- **[Socket.dev](https://socket.dev)** — 공급망 공격(malicious npm package) 탐지. `npm install` 시 악성 패키지 경고.
- **[Trivy](https://trivy.dev)** — Docker 이미지·쿠버네티스 매니페스트 취약점. 컨테이너 쓰면 필수.
- **[OWASP ZAP](https://www.zaproxy.org)** — DAST (Dynamic, 실행 중 앱 스캔). 로그인 플로우 자동 테스트.

**솔직한 평가**: 스타트업 초기엔 불필요. gitleaks + Dependabot + Sentry 조합으로 90% 커버. 위 도구들은 "우리 팀 8명 + SOC2 준비 중" 같은 단계에서 검토.

---

### 📊 한 눈에 정리

**Day-1 (첫 커밋 전)**
- [ ] gitleaks pre-commit hook
- [ ] `.gitignore`에 `.env*` 포함

**Week-1 (GitHub 레포 생성 직후)**
- [ ] `.github/dependabot.yml` 생성

**런칭 직전**
- [ ] Sentry 연결 + `beforeSend` PII 마스킹 + Slack 알림
- [ ] Cloudflare DNS/Proxy + Bot Fight Mode
- [ ] Uptime 모니터링 + 무시 못 하는 알림 채널
- [ ] safeship 전체 스캔 1회 (static + http)

**주 1회 루틴 (15~30분)**
- [ ] Dependabot PR 리뷰·병합
- [ ] Sentry 새 에러 대시보드 확인
- [ ] `safeship http <prod-url>` 헤더 회귀 체크
- [ ] 월 1회: `npm audit fix` + 테스트

**CI에 최소한 이것만 넣으세요**: GitHub Actions의 `security.yml` 워크플로우에 `gitleaks detect` + `npm audit --audit-level=high` (또는 `govulncheck`). 10분 세팅으로 가장 큰 사고 두 가지(시크릿 유출, CVE 취약점)는 자동 차단됩니다.

```yaml
# .github/workflows/security.yml
name: Security
on: [push, pull_request]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
        env: { GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci && npm audit --audit-level=high
```

---

## 7. "AI 코딩 시 보안 멘탈 모델"

외우세요:

1. **AI는 시킨 것만 한다.** 안 시킨 보안은 안 생긴다.
2. **프론트는 UX. 서버는 방어.** 프론트에서 숨긴 건 보안이 아니다.
3. **클라이언트가 보낸 값은 전부 거짓일 수 있다.** 소유권 판단에 쓰면 안 됨.
4. **에러 메시지는 공격자에게 주는 힌트.** 구체적일수록 위험.
5. **배포는 끝이 아니라 시작.** 주 1회 헤더·시크릿 재스캔.

---

## 8. 막히면

- 모르는 보안 개념이 나오면 → AI에게 "이게 왜 위험한지 초보 수준으로 설명해줘" 물어보기. **설명을 못 하면 그 AI의 출력을 신뢰하지 마세요.**
- 의사결정이 어려우면 → 이 파일의 [7. 멘탈 모델](#7-ai-코딩-시-보안-멘탈-모델) 5개 기준으로 판단.
- 인시던트 의심 → 일단 서비스 차단 + 키 전부 로테이션 + 로그 백업. 정리는 나중에.

---

## 부록: 이 가이드의 한계

이 문서는 **사고의 90%를 막기 위한 최소 기준**입니다. 완벽하지 않습니다.

- 실제 상용 서비스는 외부 침투 테스트를 최소 연 1회.
- 복잡한 RLS 정책, OAuth 플로우, 암호화 구현은 전문가 리뷰.
- 규제 산업(금융·의료)은 이 가이드 외에 해당 컴플라이언스 기준 별도 적용.

이 정도 해도 "바이브코딩으로 시작해서 상업 서비스로 성장"하는 경로의 대부분을 안전하게 통과할 수 있습니다.

---

## 부록: 주제별 심화 가이드

기능 구현할 때 해당 가이드만 읽으세요. 전부 읽을 필요 없음.

| 언제 | 가이드 |
|---|---|
| 결제 붙이는 중 (Stripe/Toss/LemonSqueezy) | [guides/01-payment-webhooks.md](./guides/01-payment-webhooks.md) |
| DB 모델 / Supabase 설정 중 | [guides/02-database.md](./guides/02-database.md) |
| 로그인 / 매직링크 / OAuth 구현 중 | [guides/03-auth-session.md](./guides/03-auth-session.md) |
| 이미지·파일 업로드 기능 만드는 중 | [guides/04-file-upload.md](./guides/04-file-upload.md) |
| OpenAI / Claude / Gemini 연동 중 | [guides/05-ai-llm-integration.md](./guides/05-ai-llm-integration.md) |
| API 서버 만들고 CORS 에러 뜨는 중 | [guides/06-cors-api.md](./guides/06-cors-api.md) |
| 이메일 / SMS 발송 붙이는 중 | [guides/07-email-sms.md](./guides/07-email-sms.md) |
| 첫 배포 앞두고 | [guides/08-deployment-infra.md](./guides/08-deployment-infra.md) |
| React Native / Flutter / iOS·Android 앱 | [guides/09-mobile-apps.md](./guides/09-mobile-apps.md) |
| Socket.io / SSE / 실시간 기능 | [guides/10-websocket-realtime.md](./guides/10-websocket-realtime.md) |
| Web3 dApp / 지갑 / 스마트 컨트랙트 | [guides/11-crypto-wallet.md](./guides/11-crypto-wallet.md) |
| 개인정보 처리·약관·쿠키 배너 | [guides/12-compliance-privacy.md](./guides/12-compliance-privacy.md) |
| 사고 났거나 유출 의심되는 지금 | [guides/13-incident-response.md](./guides/13-incident-response.md) |

[guides/README.md](./guides/README.md)에 빠른 경로 있습니다.
