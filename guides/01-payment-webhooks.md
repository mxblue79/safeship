# 결제 & 웹훅 보안 가이드

> 대상: Stripe / Toss / LemonSqueezy / PayPal / KG이니시스 등 PG 연동.
> 실 피해 규모가 가장 큰 영역. 버그 하나당 수백만~수천만원.

## 왜 자주 터지나

결제 플로우는 **프론트/백엔드/PG 서버** 3자가 비동기로 주고받는 구조라, 초보자가 "성공했다고 UI에 뜨면 성공" 수준으로 구현하면 빈틈이 생깁니다.

AI는 보통 결제 UI는 잘 만들지만 **웹훅 서명 검증, 금액 재조회, 멱등성**을 명시적으로 시키지 않으면 전부 누락합니다.

## 피해 실예

- **무료 프리미엄 전환**: 결제 "성공" 판정을 프론트가 하는 구조 → 공격자가 DevTools에서 `POST /unlock-premium` 직접 호출 → 무료로 프리미엄 전체 획득
- **환불 조작**: 웹훅 서명 검증 없이 받음 → 공격자가 가짜 `refund.succeeded` 이벤트 전송 → 실제로는 결제 안 했는데 환불 처리되어 잔액 차감
- **금액 조작**: 프론트가 보낸 금액을 그대로 DB에 저장 → 100원 결제했는데 10만원으로 저장, 반대도 가능
- **중복 지급**: 웹훅 재시도 대비 없음 → PG가 "혹시 못 받았나?" 싶어 같은 이벤트 재전송 → 상품 10번 지급

## 핵심 원칙 4가지

### 1. 결제 성공 판정은 서버가 PG에 직접 재조회해서 한다
프론트가 "success" 신호 줘도 믿으면 안 됨. 반드시 서버가 PG API로 order_id를 조회해서 확정.

```ts
// ❌ 위험
app.post('/confirm', (req, res) => {
  if (req.body.status === 'success') {
    db.grantPremium(req.body.user_id)  // 프론트 말만 믿음
  }
})

// ✅ 올바름
app.post('/confirm', requireAuth, async (req, res) => {
  const { orderId } = req.body
  // 서버가 PG에 직접 재조회
  const payment = await toss.payments.get(orderId)
  if (payment.status !== 'DONE') return res.status(400).json({})
  // DB에 기록된 예상 금액과 PG 실제 금액 일치 확인
  const order = await db.orders.find(orderId)
  if (payment.totalAmount !== order.amount) return res.status(400).json({})
  // 이미 처리했으면 중복 방지
  if (order.status === 'paid') return res.json({ ok: true })
  await db.orders.markPaid(orderId)
  await db.grantPremium(req.user.id)
})
```

### 2. 웹훅은 반드시 서명 검증

각 PG가 제공하는 서명 검증을 **안 하면 아무나 가짜 이벤트 쏠 수 있습니다.**

```ts
// Stripe 예시
import Stripe from 'stripe'
const stripe = new Stripe(process.env.STRIPE_SECRET!)

app.post('/webhook/stripe',
  express.raw({ type: 'application/json' }),  // raw body 필수
  (req, res) => {
    const sig = req.headers['stripe-signature']
    let event
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET!
      )
    } catch (err) {
      return res.status(400).send('Invalid signature')  // 거부
    }
    // 여기부터 event는 신뢰 가능
  }
)
```

Toss는 `secret + body` HMAC-SHA256 직접 구현, LemonSqueezy는 `X-Signature` 헤더 HMAC 비교. **각 PG 문서 정확히 따르기.**

### 3. 금액은 서버에 저장된 값을 PG와 대조

```ts
// ❌ 위험 — 프론트에서 받은 금액으로 결제창 띄움
const { amount } = req.body  // 사용자가 조작 가능
initPayment({ amount })

// ✅ 올바름 — DB의 상품 가격 조회
const product = await db.products.find(req.body.productId)
initPayment({ amount: product.price })  // 서버만 아는 값
```

### 4. 멱등성 (같은 이벤트 두 번 처리 안 되게)

PG는 네트워크 불안정 시 같은 웹훅을 여러 번 보냅니다. `event_id`를 DB에 기록해서 중복 처리 방지.

```ts
app.post('/webhook/stripe', async (req, res) => {
  const event = verifySignature(req)
  // 이미 처리했으면 즉시 200 반환 (재시도 중단)
  const existing = await db.webhookEvents.find(event.id)
  if (existing) return res.status(200).send('already processed')
  // 트랜잭션 안에서 비즈니스 로직 + 이벤트 기록
  await db.transaction(async tx => {
    await tx.webhookEvents.insert({ id: event.id, type: event.type })
    await processPayment(event, tx)
  })
  res.status(200).send('ok')
})
```

## AI에게 시킬 때 덧붙일 프롬프트

````
결제/웹훅 코드 작성할 때 다음 규칙 필수:

1. 결제 확정(프리미엄 지급, 잔액 변경 등)은 서버가 PG API로 order_id를
   재조회해서 status='DONE' 확인한 뒤에만 수행. 프론트의 "success" 응답
   단독으로는 절대 확정하지 않음.
2. 웹훅 엔드포인트는 반드시 해당 PG의 서명 검증 로직을 먼저 통과한 뒤에
   body를 사용. Stripe는 constructEvent, Toss/LemonSqueezy는 HMAC 직접 비교.
3. 결제 금액은 DB에 저장된 상품 가격을 PG가 반환한 실제 결제 금액과 대조.
   프론트에서 받은 금액으로 결제창 띄우지 말 것.
4. 웹훅 이벤트 처리 전에 event.id를 DB에 조회해서 중복 방지. 트랜잭션
   안에서 event 기록 + 비즈니스 로직을 함께 수행.
5. 웹훅 라우트는 2xx 응답을 빨리 반환하고, 무거운 작업은 큐/백그라운드로
   분리. PG는 타임아웃 시 재시도해서 중복 처리 위험 커짐.
6. Stripe는 raw body가 필요하므로 express.raw() 또는 해당 프레임워크의
   동등 미들웨어를 웹훅 라우트에만 적용.
````

## 지뢰 10개

1. **프론트가 결제 성공 판정** — 2번 문단 참조
2. **웹훅 서명 검증 생략** — 공격자가 가짜 `payment.succeeded` 전송
3. **프론트에서 금액 전송** — URL 파라미터, body에서 받아서 DB에 저장
4. **webhook secret을 `NEXT_PUBLIC_`에** — 서명 검증이 무의미해짐
5. **같은 event 중복 처리 안 막음** — PG 재시도로 상품 여러 번 지급
6. **raw body 안 써서 Stripe 서명 검증 항상 실패** — 결과적으로 검증 우회
7. **test/live 키 혼동** — `sk_test_*`로 live 결제 시도, 또는 반대
8. **환불 로직에 사용자 권한 체크 없음** — 남의 주문 환불 가능
9. **결제 성공 로그에 카드번호·CVV 기록** — PCI DSS 위반
10. **웹훅 IP allowlist 없음** — PG 공식 IP만 받아야 하는데 전 세계 오픈

## 머지 전 체크리스트

- [ ] 웹훅 서명 검증 통과 못 하면 **400/401**로 거부 (200 반환 금지)
- [ ] 웹훅 raw body / 원본 header 접근 가능 (프레임워크 기본 JSON parser가 먹어치우지 않음)
- [ ] `event.id` 또는 `idempotency_key`로 중복 차단
- [ ] 결제 상태 전이 `pending → paid` 단일 방향, 중복 호출 OK
- [ ] DB 금액 vs PG 응답 금액 비교
- [ ] 카드번호·CVV·서명은 로그에 남지 않음
- [ ] test / live 키 분리, env로만 주입
- [ ] 환불·구독취소도 **사용자 소유권 확인** 후 처리
- [ ] PG 대시보드에서 웹훅 endpoint `https://` + 정확한 경로 등록 (HTTP X)
- [ ] 해당 PG 공식 IP 범위로 allowlist (가능한 경우)

## 참고
- Stripe: https://docs.stripe.com/webhooks
- Toss: https://docs.tosspayments.com/guides/webhook
- LemonSqueezy: https://docs.lemonsqueezy.com/guides/webhooks
- PayPal: https://developer.paypal.com/api/rest/webhooks/
