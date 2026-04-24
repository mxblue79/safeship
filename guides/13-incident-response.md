# 인시던트 대응 플레이북

> 대상: 유출·침해·이상 현상 의심될 때 "뭘 먼저 해야 하나" 모를 때 꺼내 읽는 문서.
> 사고는 **반드시** 일어난다는 전제. 문제는 "얼마나 빠르게·정확히 대응하나".

## 사고 유형별 우선순위 매트릭스

| 의심 상황 | 심각도 | 1시간 내 행동 | 24시간 내 행동 |
|---|---|---|---|
| GitHub에 시크릿 커밋 발견 | 🚨 | 키 로테이션 | 히스토리 정리, 로그 감사 |
| 프로덕션 DB 덤프 유출 의심 | 🚨 | DB 비밀번호 변경, 모든 세션 로그아웃 | 사용자 통지, 당국 신고 |
| 결제 이상(환불·중복 과금) 폭증 | 🚨 | 결제 엔드포인트 일시 차단 | 로그 분석, PG사 협조 |
| LLM API 청구액 폭증 | 🔴 | 키 비활성, 새 키 발급 | rate limit 재설정 |
| 계정 탈취 신고 다수 | 🔴 | 비밀번호 재설정 강제, 2FA 활성화 안내 | 유출 원인 파악 |
| DDoS 공격 | 🟡 | Cloudflare Under Attack 모드 | 장기 대책 |
| 버그 바운티 제보 수신 | 🟡 | 24시간 내 응답, PoC 검증 | 패치 + 공개 일정 협의 |

## 즉시 하지 말아야 할 것 (본능적 실수)

1. **로그 삭제 금지** — 원인 분석 증거. 감정적으로 "덮자"는 생각 통제.
2. **관련 직원 문책 먼저 금지** — 대응에 집중, 책임은 사후.
3. **public 공지 서두르지 말 것** — 규모·원인 파악 전 부정확한 정보는 2차 피해.
4. **커밋 히스토리만 rewrite로 덮기 금지** — 이미 유출된 키는 이미 유출됨. 로테이션이 근본.
5. **SNS 반박 금지** — 사실관계 확실하지 않은 상태에서.

## 공통 초기 대응 (처음 1시간)

### 1. 증거 보존
```bash
# 로그·DB 상태 즉시 snapshot
pg_dump -f /tmp/incident-$(date +%Y%m%d-%H%M).sql
tar czf /tmp/logs-$(date +%Y%m%d).tar.gz /var/log/myapp/
aws s3 cp /tmp/incident-*.sql s3://incident-backup/ --sse
```

Vercel/Railway 로그는 해당 대시보드에서 export. 30일 이상 유지되는지 확인.

### 2. 공격 면 차단
- 문제 있는 엔드포인트 Cloudflare Rule로 즉시 차단
- 필요 시 **유지보수 페이지**로 전체 사이트 전환
- 의심 세션 전수 무효화: `DELETE FROM sessions WHERE ...`

### 3. 대응팀 소집
혼자 운영이면 스스로 "지금부터 2시간 인시던트 모드" 선언. 다른 업무 정지.

### 4. 타임라인 문서 시작
```
=== INCIDENT 2026-04-24 ===
14:02 유출 의심 이메일 수신
14:05 확인: prod DB backup URL이 공개 S3
14:08 버킷 private 전환 완료
14:15 영향 범위 파악 시작...
...
```
사후 보고·재발 방지 계획 작성에 필수.

## 시나리오별 플레이북

### 시나리오 A: GitHub에 API 키 커밋됐다

```
발견 즉시:
1. 해당 서비스(OpenAI/Stripe/AWS)에서 키 폐기 → 새 키 발급
   ← 가장 먼저. 1분이라도 빠르게.
2. 새 키를 환경변수에 반영 → 배포
3. 폐기한 키의 로그 확인 (OpenAI는 Usage 페이지, AWS는 CloudTrail)
   → 내가 호출하지 않은 이상 호출 있었으면 유출 확정

그 다음:
4. git 히스토리에서 키 제거: BFG Repo-Cleaner
   git clone --mirror <repo>
   bfg --replace-text passwords.txt
   git reflog expire --expire=now --all
   git gc --prune=now --aggressive
   git push --force
5. 팀원이 있으면 force push 전 공지
6. 커밋된 키가 진짜 유출됐는지 GitHub Secret Scanning / Trufflehog 로그 확인
```

**중요**: 히스토리 정리는 유출 방지가 **아닙니다**. 이미 스캔된 키는 여전히 exist. 유일한 방어는 **즉시 폐기**.

### 시나리오 B: 프로덕션 DB 접근 의심

```
1. DB 접근 로그 확인 (PostgreSQL pg_stat_activity, MySQL general_log,
   Supabase Logs 탭)
2. 익숙하지 않은 IP·쿼리 발견 시:
   a. 해당 접속 즉시 kill: SELECT pg_terminate_backend(pid) WHERE ...
   b. DB 비밀번호 전체 교체 (Primary + Replica)
   c. 모든 앱의 DB 연결 문자열 갱신 + 재배포
3. 테이블별 row 수 비교 (정상 수치 대비 급증 = 백업 시도 흔적)
4. `pg_stat_database` 에서 tup_returned (읽힌 튜플 수) 급증 체크
5. 영향받은 사용자 수 산출
6. 72시간 내 당국 신고 준비 (12-compliance 참조)
7. 영향받은 사용자에게 통지:
   - 유출된 데이터 종류
   - 비밀번호 재설정 요청
   - 이상 활동 모니터링 권고
```

### 시나리오 C: 결제 이상

```
1. 결제 엔드포인트 일시 차단 (maintenance 모드)
2. 의심 패턴 특정:
   - 환불 폭증: attacker가 웹훅 스푸핑 시도?
   - 중복 과금: 멱등성 체크 버그?
   - 금액 변조: 프론트→서버 금액 전달 버그?
3. PG사 대시보드와 내 DB 결제 기록 교차 확인
4. PG사 고객지원에 "공격 의심, 조사 요청" 연락
5. 사기성 거래는 PG에 환불·취소 요청
6. 원인 수정 후 점진적 재오픈:
   - 내부 테스트 계정으로 먼저
   - 소규모 사용자 대상 A/B
   - 전체 오픈
```

### 시나리오 D: LLM API 청구 폭탄

```
1. 대시보드에서 비정상 사용량 확인 (시간대별 스파이크)
2. 키 즉시 비활성 → 새 키 발급
3. 청구 한도(hard limit) 설정되어 있는지 확인 (없으면 지금 설정)
4. 유출 경로 추적:
   - 프론트 코드에 NEXT_PUBLIC_으로 노출됐나
   - GitHub 공개 커밋에 포함됐나
   - 내 서버에 Rate limit 없어서 남용됐나
5. 해당 서비스에 "fraudulent usage" 신고로 부분 환급 요청
   (성공률 낮지만 시도할 가치 있음)
6. 서버 미들웨어에 사용자별 + IP별 rate limit + 월간 cap 추가
```

### 시나리오 E: DDoS / 봇 공격

```
1. Cloudflare 대시보드 → "Under Attack Mode" ON
   → 모든 방문자에게 5초 챌린지
2. Analytics 에서 공격 패턴 확인:
   - 특정 국가? → Firewall Rule로 해당 국가 차단
   - 특정 User-Agent? → Rule 추가
   - 특정 경로에 집중? → Rate Limiting 규칙
3. Origin 서버 IP 숨김 확인 (Cloudflare Proxy 경유하는지)
4. Scale up (Vercel/Railway 자동 스케일) 또는 서비스 재시작
5. 공격 종료 후 "Under Attack Mode" OFF. 평상시 Bot Fight Mode는 유지.
```

### 시나리오 F: 버그 바운티 제보

제보자에게 **하루 안에 응답**은 기본 예의. 응답 안 하면 제보자가 공개해버림.

```
1. 재현 시도 (PoC 따라하기) — 실제 취약 여부 확인
2. 영향 범위 파악 (한 사용자 / 전체 DB / 서버 장악 여부)
3. CVSS 점수 산출 또는 대략적 심각도 판단
4. 제보자에게 "확인했고 패치 중" 응답
5. 패치 → 배포 → 검증
6. 제보자에게 크레딧 공지 (blog 또는 hall of fame)
7. 감사 표시: 현금 / 스티커 / 크레딧 (규모에 맞게)

제보 수신 채널 미리 준비:
- security@yourdomain.com (DMARC 검증된 주소)
- security.txt 파일: https://yourdomain.com/.well-known/security.txt
```

## 사후 필수 작업

```
1. RCA(Root Cause Analysis) 문서 작성
   - 무엇이 일어났나
   - 언제·어떻게 탐지했나
   - 대응 타임라인
   - 근본 원인
   - 재발 방지 대책
2. 재발 방지 기술 변경
   - 시크릿이면: pre-commit hook, gitleaks CI, env 관리 툴
   - IDOR이면: 전 엔드포인트 권한 체크 감사
   - 결제면: 멱등성 + 서명 검증 재점검
3. 모니터링 강화
   - 유사 패턴 알림 추가
   - 로그 보존 기간 연장 검토
4. 팀 공유 (솔로면 본인 메모)
   - 다음 프로젝트에서 같은 실수 안 하도록
5. 필요 시 사용자 공개 post-mortem
```

## 미리 준비할 것 (평상시)

### 연락처 리스트
```
개인정보보호위원회:    02-2100-3061
KISA:                 118 (보호나라)
각 PG사 고객지원:     ...
주요 클라우드 지원:   AWS/GCP/Azure/Vercel/Railway support URL
변호사 (선택):        개인정보·IT 전문
```

### 도구 설치
- gitleaks (커밋 스캔)
- BFG Repo-Cleaner (히스토리 정리)
- curl / httpie (API 빠른 확인)
- Cloudflare 대시보드 접근 권한

### 접근 권한 점검
혼자 운영이면 본인 2FA 백업 코드 보관. 팀이면 최소 2명이 프로덕션 접근 가능해야 (한 명 휴가·사고 시 마비 방지).

### 모의 훈련
6개월에 한 번 "가상 시나리오"로 연습. "만약 지금 DB 유출됐다면 첫 1시간 뭐 할래?" 자문자답.

## AI에게 인시던트 대응 관련 시킬 때

````
보안 인시던트 대응 코드·프로세스 작성 시 다음 규칙:

1. "시크릿 발견 → 즉시 삭제 커밋"을 제안하지 말 것. 키 로테이션이 먼저.
2. 로그 파일을 rotate/cleanup할 때 최소 30일은 보존.
3. 감사 로그(로그인, 결제, 관리자 액션)는 read-only 형태로 별도 저장.
4. 장애 대응 중 `git push --force`는 반드시 확인받고 실행.
5. 인시던트 발생 시 실행할 스크립트(세션 전체 무효화, 모든 API 키 회전)는
   미리 작성해두고 테스트.
6. security.txt를 /.well-known/ 아래 배치. security@ 이메일 주소 수신 확인.
7. 통지 이메일 템플릿을 미리 준비 (실제 터지면 침착하게 작성 불가).
````

## 참고
- NIST 인시던트 대응 가이드: https://csrc.nist.gov/publications/detail/sp/800-61/rev-2/final
- security.txt 표준: https://securitytxt.org
- SANS Incident Handler Handbook: https://www.sans.org/white-papers/33901/
- 개인정보 유출 신고: https://www.privacy.go.kr
- KISA 보호나라: https://www.boho.or.kr
