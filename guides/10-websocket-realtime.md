# WebSocket / 실시간 통신 보안 가이드

> 대상: Socket.io / native WebSocket / SSE / Pusher / Ably / Supabase Realtime.
> 실시간 채팅·협업·게임·주식 시세 같은 기능 만들 때.

## 왜 별도 가이드가 필요한가

HTTP는 요청·응답 1회로 끝나지만 WebSocket은 **오래 유지되는 연결**. 그래서:
- 초기 연결 시 인증을 안 하면 그 후로 영원히 인증 안 됨
- 연결당 메모리 쌓임 → 느린 리소스 소진 공격 가능
- 메시지 폭격(한 연결에서 초당 수천 메시지)으로 서버·다른 사용자에게 피해
- 채널·방(room) 구독을 아무나 할 수 있으면 **비밀 대화 실시간 엿보기**

## 피해 실예

- **채널 구독에 권한 체크 없음**: 공격자가 `subscribe("admin-chat")` 보냄 → 관리자 비밀 채팅 실시간 수신
- **메시지 폭격 rate limit 없음**: 한 클라이언트가 초당 수만 메시지 → 서버 CPU 100% + 다른 유저 모두 끊김
- **메시지 브로드캐스트에 sender 위조**: `{ type: 'chat', from: 'admin', text: '긴급 공지' }` → 아무나 admin 사칭
- **연결 리크**: 인증 실패한 소켓을 `close` 안 함 → 메모리 소진
- **WebSocket `ws://`로 배포**: HTTPS 페이지에서 WS 쓰면 MITM 가능

## 핵심 원칙 6가지

### 1. 연결 시 인증 + 구독 시 권한 체크

**두 시점 모두**에서 검증.

```ts
// Socket.io 예시
io.use(async (socket, next) => {
  // ① 연결 시 인증 (handshake에서 토큰)
  const token = socket.handshake.auth.token
  const user = await verifyJWT(token)
  if (!user) return next(new Error('unauthorized'))
  socket.data.user = user
  next()
})

io.on('connection', (socket) => {
  socket.on('subscribe', async ({ roomId }) => {
    // ② 구독 시 권한 (해당 방에 들어갈 수 있는 사람인지)
    const allowed = await canUserAccessRoom(socket.data.user.id, roomId)
    if (!allowed) return socket.emit('error', { code: 'forbidden' })
    socket.join(roomId)
  })
})
```

Supabase Realtime은 **RLS가 실시간 스트림에도 적용**됨. 02-database 가이드의 RLS 설정이 그대로 보호막.

### 2. sender는 서버가 주입 (클라이언트 신뢰 금지)

```ts
// ❌ 클라이언트가 from 지정
socket.on('chat', ({ roomId, from, text }) => {
  io.to(roomId).emit('chat', { from, text })  // 위조 가능
})

// ✅ 서버가 socket.data.user에서 추출
socket.on('chat', async ({ roomId, text }) => {
  if (!socket.rooms.has(roomId)) return  // 구독 안 한 방으로는 못 보냄
  io.to(roomId).emit('chat', {
    from: socket.data.user.id,       // 서버가 아는 값
    fromName: socket.data.user.name,
    text,
    at: new Date().toISOString()
  })
})
```

### 3. Rate limit (연결당 + 사용자당)

```ts
// 연결 소켓마다 메시지 카운터
socket.on('chat', rateLimited(async (msg) => {
  // ...
}))

function rateLimited(handler) {
  const buckets = new WeakMap()
  return async function(msg) {
    const bucket = buckets.get(this) || { count: 0, reset: Date.now() + 1000 }
    if (Date.now() > bucket.reset) { bucket.count = 0; bucket.reset = Date.now() + 1000 }
    if (++bucket.count > 10) return this.emit('error', { code: 'rate' })  // 초당 10개
    buckets.set(this, bucket)
    return handler.apply(this, arguments)
  }
}
```

프로덕션에서는 Redis 기반(Upstash 등)으로 사용자 전체 연결 합산 rate limit.

### 4. 메시지 크기 제한

```ts
// Socket.io
const io = new Server(httpServer, {
  maxHttpBufferSize: 1e6  // 1MB. 기본값 1MB지만 명시 권장
})
```

WebSocket 라이브러리별로 메시지 최대 크기 확인. 안 하면 1GB 텍스트로 서버 메모리 폭발.

### 5. `wss://` 강제 + CORS·Origin 검증

```ts
// HTTP 업그레이드 핸드셰이크에서 Origin 헤더 체크
const ALLOWED = ['https://myapp.com']
const io = new Server(httpServer, {
  cors: {
    origin: (origin, cb) => {
      if (ALLOWED.includes(origin)) cb(null, true)
      else cb(new Error('Not allowed'))
    }
  }
})
```

native WebSocket 서버면 `verifyClient`에서 `info.req.headers.origin` 검증.

### 6. 연결 수명 관리

- **유휴 연결 timeout**: 30분 이상 ping 없으면 끊기
- **사용자당 동시 연결 수 제한**: 한 계정이 수만 소켓으로 어택 가능
- **실패 시 정리**: 인증 실패면 즉시 `socket.disconnect(true)`

```ts
io.use((socket, next) => {
  if (!authOk) {
    next(new Error('unauthorized'))
    return  // Socket.io가 자동으로 연결 종료
  }
  next()
})

// 사용자당 연결 수 제한
const userSockets = new Map()  // userId → Set<socketId>
io.on('connection', (socket) => {
  const userId = socket.data.user.id
  const set = userSockets.get(userId) || new Set()
  if (set.size >= 5) return socket.disconnect(true)  // 최대 5연결
  set.add(socket.id)
  userSockets.set(userId, set)
  socket.on('disconnect', () => set.delete(socket.id))
})
```

## AI에게 시킬 때 덧붙일 프롬프트

````
WebSocket / Socket.io / Realtime 코드 작성 시 다음 규칙:

1. 연결 handshake에서 JWT/세션 토큰 검증. 인증 실패 즉시 disconnect.
2. 채널·방(room) subscribe 이벤트마다 해당 사용자의 접근 권한 서버 측 확인.
   구독 안 한 방으로 메시지 못 보내도록.
3. 메시지 broadcast 시 sender·from 필드는 서버가 socket.data.user에서 주입.
   클라이언트가 보낸 값 그대로 전파 금지.
4. 이벤트별 rate limit 적용(예: chat 초당 10개, 총 메시지 분당 100개).
5. maxHttpBufferSize / maxPayload로 메시지 크기 1MB 이하 제한.
6. wss:// 강제 (ws:// 금지). 핸드셰이크에서 Origin 헤더 allowlist 검증.
7. 사용자당 동시 연결 수 상한(예: 5) 적용.
8. 유휴 연결 timeout(heartbeat ping 없으면 30분에 끊기).
9. Supabase Realtime 쓰면 모든 테이블 RLS 활성 + 정책 작성 필수.
````

## 지뢰 10개

1. **handshake 인증 없이 연결 허용** — 이후 모든 이벤트 무방비
2. **구독 시 권한 체크 생략** — 남의 방 엿보기
3. **sender를 클라이언트 body에서** — admin 사칭, 타인 명의 메시지
4. **rate limit 없음** — 한 클라이언트가 초당 수천 메시지
5. **`ws://` 배포** — MITM 전체 트래픽 복호화
6. **Origin 검증 생략** — 타 도메인에서 내 WS 서버로 연결·남용
7. **연결 실패 시 메모리 정리 안 함** — 좀비 소켓 누적
8. **메시지 크기 제한 없음** — 1GB 하나로 OOM
9. **Supabase Realtime에 RLS 없는 테이블 공개** — 변경사항 전부 구독 가능
10. **인증 실패 시 상세 에러 반환** — 계정 존재 여부 열거

## 머지 전 체크리스트

- [ ] 연결 handshake에서 토큰 검증
- [ ] 구독·발행 이벤트마다 권한 체크
- [ ] sender 필드는 서버 주입
- [ ] 이벤트별 rate limit
- [ ] 메시지 크기 제한 (1MB 이하)
- [ ] `wss://` 강제
- [ ] Origin allowlist
- [ ] 사용자당 동시 연결 상한
- [ ] 유휴 연결 ping/pong + timeout
- [ ] Supabase Realtime이면 RLS 정책 완비
- [ ] 연결 실패·종료 시 정리 로직
- [ ] 에러 응답에 내부 정보 노출 없음

## 참고
- Socket.io Production: https://socket.io/docs/v4/production-checklist/
- OWASP WebSocket: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#websocket-authentication
- Supabase Realtime RLS: https://supabase.com/docs/guides/realtime/postgres-changes#private-channels
