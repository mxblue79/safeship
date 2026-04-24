# 데이터베이스 보안 가이드

> 대상: Postgres / MySQL / SQLite / MongoDB / Supabase / Firebase 사용.
> 모든 프로젝트가 쓰는 영역. 실수 하나가 "전 사용자 데이터 유출".

## 왜 자주 터지나

AI는 ORM(Prisma, Drizzle, TypeORM, GORM) 쓰면 SQL Injection은 잘 피합니다. 문제는 **다른 3가지**:
1. **IDOR** — 남의 데이터 조회/수정 가능
2. **전 테이블 공개** — Supabase에서 RLS 안 켜서 anon key로 전체 다 털림
3. **ORDER BY·트랜잭션 누락** — 데이터 정합성 깨짐

## 피해 실예

- **Supabase 전체 테이블 공개**: 스타트업 개발자가 RLS 안 켜고 배포 → 유저 1만명 개인정보 anon key로 조회 가능. 국내 실제 사례 다수.
- **IDOR로 타인 주문 조회**: `GET /orders/123`에 소유자 체크 없음 → ID만 바꿔가며 전체 주문 수집
- **프론트 ID 신뢰**: 결제 연동 부분 보면 `user_id`를 body로 받아 insert → 공격자가 다른 사람 이름으로 데이터 작성
- **숨긴 소프트 삭제가 공개**: `deletedAt IS NULL` 조건 빠진 API → 탈퇴한 유저 데이터까지 조회
- **관리자 도구 공개 노출**: Prisma Studio, pgAdmin을 방화벽 없이 public 포트로 올림

## 핵심 원칙 5가지

### 1. user_id · tenant_id · role은 세션에서만 꺼낸다 (body 금지)

```ts
// ❌ 치명적 — 공격자가 user_id 바꿔 남의 이름으로 글 작성
app.post('/posts', (req, res) => {
  db.posts.create({
    user_id: req.body.user_id,  // 신뢰 불가
    content: req.body.content
  })
})

// ✅ 세션에서 꺼내기
app.post('/posts', requireAuth, (req, res) => {
  db.posts.create({
    user_id: req.user.id,  // JWT/세션에서 추출, 변조 불가
    content: req.body.content
  })
})
```

### 2. 리소스 조회·수정은 반드시 소유권 체크

```ts
// ❌ IDOR
app.get('/orders/:id', requireAuth, async (req, res) => {
  const order = await db.orders.find(req.params.id)
  res.json(order)  // 인증은 됐지만 남의 주문도 반환
})

// ✅ 소유권 체크
app.get('/orders/:id', requireAuth, async (req, res) => {
  const order = await db.orders.find(req.params.id)
  if (!order) return res.status(404).json({ error: 'not found' })
  if (order.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' })
  res.json(order)
})
```

또는 WHERE 절에 직접:
```ts
const order = await db.orders.find({ id: req.params.id, user_id: req.user.id })
if (!order) return res.status(404).json({})  // 존재 여부도 노출 안 됨
```

### 3. Supabase/Firebase는 RLS 필수

**RLS 없이 배포한 Supabase는 전 사용자 DB를 공개한 것과 같습니다.** anon key는 누구나 프론트 번들에서 볼 수 있으니까.

```sql
-- 모든 테이블에 적용
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;

-- SELECT: 본인 것만
CREATE POLICY "read own" ON posts
  FOR SELECT USING (auth.uid() = user_id);

-- INSERT: 본인 user_id로만 insert (WITH CHECK 필수)
CREATE POLICY "insert own" ON posts
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- UPDATE: USING은 수정 대상 선별, WITH CHECK는 수정 후 값 검증
CREATE POLICY "update own" ON posts
  FOR UPDATE USING (auth.uid() = user_id)
          WITH CHECK (auth.uid() = user_id);

-- DELETE: USING만
CREATE POLICY "delete own" ON posts
  FOR DELETE USING (auth.uid() = user_id);
```

**함정**: `INSERT`에 `WITH CHECK` 빠지면 공격자가 `user_id`를 다른 사람 것으로 넣고 통과됨. 4가지 작업(SELECT/INSERT/UPDATE/DELETE) 전부 명시.

### 4. SQL Injection — ORM 써도 Raw 쿼리 조심

```ts
// ❌ ORM 안에서도 Raw로 문자열 연결
db.$queryRawUnsafe(`SELECT * FROM users WHERE email = '${email}'`)

// ✅ 파라미터 바인딩
db.$queryRaw`SELECT * FROM users WHERE email = ${email}`  // tagged template
// 또는
db.users.findFirst({ where: { email } })  // ORM 메서드
```

Go GORM:
```go
// ❌
db.Raw("SELECT * FROM users WHERE email = '" + email + "'")

// ✅
db.Raw("SELECT * FROM users WHERE email = ?", email)
```

### 5. 트랜잭션 + ORDER BY

**PostgreSQL MVCC 함정**: UPDATE된 row는 테이블 물리적 끝으로 이동. 정렬 없이 조회하면 순서가 변합니다.

```ts
// ❌ 결과 순서 보장 안 됨 (UPDATE 후 뒤로 감)
const entries = await db.entries.findMany({ where: { projectId } })

// ✅ 명시적 정렬
const entries = await db.entries.findMany({
  where: { projectId },
  orderBy: { id: 'asc' }
})
```

자금 이체·재고 차감 같은 원자성 필요한 작업은 **트랜잭션**으로 묶기:
```ts
await db.$transaction(async (tx) => {
  await tx.accounts.update({ where: { id: fromId }, data: { balance: { decrement: amount } } })
  await tx.accounts.update({ where: { id: toId }, data: { balance: { increment: amount } } })
})
```

## AI에게 시킬 때 덧붙일 프롬프트

````
DB 관련 코드 작성 시 다음 규칙 적용:

1. user_id, tenant_id, role은 request body나 query에서 받지 않음. 반드시
   인증된 세션(req.user, auth.uid() 등)에서 꺼내서 사용.
2. 리소스 조회·수정·삭제 API는 WHERE 절에 user_id=현재사용자 조건을 포함하거나,
   조회 후 소유권 비교해서 403/404 반환.
3. Supabase 테이블은 ENABLE ROW LEVEL SECURITY + SELECT/INSERT/UPDATE/DELETE
   네 가지 정책을 모두 작성. INSERT·UPDATE에 WITH CHECK 절 필수.
4. Raw 쿼리 쓸 땐 파라미터 바인딩만. 문자열 연결 금지.
5. 정렬 필요하면 명시적 ORDER BY. PostgreSQL에서 UPDATE 후 row가 이동하는
   MVCC 특성 인지.
6. 금액 이체·재고 차감 등 원자성 필요한 작업은 트랜잭션으로 묶기.
7. 관리자 도구(Prisma Studio, pgAdmin 등)는 프로덕션에서 공개 포트 노출 금지.
````

## 지뢰 10개

1. **RLS 안 켜고 Supabase 배포** — anon key로 전체 DB 조회 가능
2. **`NEXT_PUBLIC_SUPABASE_SERVICE_ROLE`** — 관리자 키가 프론트 번들에. 전 DB 쓰기 권한 공개
3. **`WITH CHECK` 빼먹은 INSERT 정책** — user_id 변조 통과
4. **`findUnique({ id })` 후 소유권 체크 없음** — IDOR
5. **body에서 받은 `tenant_id`로 insert** — 멀티테넌트 경계 깨짐
6. **SELECT COUNT의 조건에 `deletedAt IS NULL` 빠짐** — 탈퇴 유저 데이터 노출
7. **`$queryRawUnsafe` + 템플릿 리터럴** — SQL Injection
8. **UPDATE 한 뒤 정렬 없이 조회** — 순서 뒤섞임 (FairPicker도 겪은 실제 이슈)
9. **마이그레이션 파일에 seed 비밀번호 하드코딩** — `admin/admin` 그대로 배포
10. **프로덕션 DB를 로컬에서 직접 접속** — `.env`의 DATABASE_URL 유출 시 즉각 침투

## 머지 전 체크리스트

- [ ] 모든 API 엔드포인트에서 `user_id`/`tenant_id`는 세션에서 추출
- [ ] 모든 SELECT·UPDATE·DELETE에 소유권 조건
- [ ] Supabase면 `SELECT tablename FROM pg_tables WHERE schemaname='public'`의 모든 테이블에 RLS 켜짐
- [ ] 각 테이블에 SELECT/INSERT/UPDATE/DELETE 4개 정책 존재
- [ ] `NEXT_PUBLIC_*`에 `service_role`·`SERVICE_KEY` 없음
- [ ] Raw 쿼리 전부 파라미터 바인딩
- [ ] 탈퇴/삭제 필터(`deletedAt IS NULL`) 모든 조회에 적용
- [ ] 테스트용 seed 계정 (admin/admin 등) 프로덕션 마이그레이션에 없음
- [ ] DB 관리자 도구는 VPN 또는 IP allowlist 뒤
- [ ] 백업 활성화 + 복구 시나리오 한 번 테스트

## 참고
- Supabase RLS: https://supabase.com/docs/guides/auth/row-level-security
- Prisma best practices: https://www.prisma.io/docs/guides/database
- PostgreSQL MVCC: https://www.postgresql.org/docs/current/mvcc-intro.html
