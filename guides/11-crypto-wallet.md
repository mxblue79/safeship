# 암호화폐 / 지갑 보안 가이드

> 대상: Web3 dApp / 지갑 연동 / 스마트 컨트랙트 호출 / 토큰 발행.
> 실수 하나가 **복구 불가능한** 자금 손실로 이어지는 영역. 웹2 보안 수준으로는 부족.

## 왜 특별한가

- **거래는 불가역**. 잘못 보낸 1 ETH는 영원히 돌아오지 않습니다 (카드처럼 chargeback 없음).
- **Private key가 곧 돈**. 키 유출 = 전 재산 이전.
- **스마트 컨트랙트는 배포 후 수정 불가** (upgradeable 패턴 아니면).
- **공격자는 자동화된 MEV·front-running 봇**. 사람보다 훨씬 빠름.

## 피해 실예

- **Private key를 `.env`에 두고 git 커밋**: 분 단위로 자동 스캐너가 발견 → 지갑 잔액 제로
- **비밀 시드를 프론트 localStorage에 저장**: XSS 한 번에 전 유저 자금 이전
- **`approve(spender, MAX_UINT256)` 무한 승인**: 악성 컨트랙트가 언제든 토큰 이전
- **가짜 WalletConnect 모달**: 피싱 사이트가 서명 요청 → 사용자가 모르고 `setApprovalForAll` 서명 → NFT 전부 탈취
- **tx replay 공격**: 서명된 거래를 다른 체인(테스트넷→메인넷)에서 재사용
- **컨트랙트 reentrancy**: 2016 The DAO 해킹 재현, 수십억 탈취 가능

## 핵심 원칙 8가지

### 1. Private key는 절대 서버·클라이언트에 평문 저장 안 함

```
❌ .env에 PRIVATE_KEY=0x...  → 커밋 유출 위험, 서버 침투 시 즉시 도난
❌ localStorage에 mnemonic 평문
❌ 클라이언트 JS 코드에 하드코딩

✅ 서버 측 서명이 필요하면: AWS KMS / HashiCorp Vault / GCP KMS 같은
   HSM 서비스에 key 보관, 서버는 서명 요청만 호출
✅ 사용자 지갑: MetaMask / WalletConnect 같은 외부 지갑에 위임.
   우리 앱이 key를 보지 않음
```

**dApp 원칙**: **당신의 앱은 절대 사용자의 private key를 받지 않음.** 사용자 지갑이 서명하고, 앱은 서명된 tx 또는 메시지만 검증.

### 2. `approve` 남용 금지

```solidity
// ❌ 사용자에게 MAX 승인 요구
token.approve(router, type(uint256).max)
// 해당 router가 훗날 손상되면 사용자 전 잔액 탈취

// ✅ 필요한 금액만 승인
token.approve(router, amount)

// 또는 Permit2 / ERC-2612 permit() 같은 세션 기반 승인
```

프론트에서 승인 요청할 땐 **사용자에게 어떤 컨트랙트에 얼마를 주는지 명확히 표시**.

### 3. 서명 메시지 명확화 (EIP-712)

```js
// ❌ plain string 서명
signer.signMessage('Login to app')
// 피싱 사이트에서 같은 메시지로 속일 수 있음

// ✅ EIP-712 typed data (도메인 + 값 구조 명시)
const domain = {
  name: 'MyApp',
  version: '1',
  chainId: 1,
  verifyingContract: '0x...'
}
const types = { Login: [
  { name: 'user', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'issuedAt', type: 'uint256' }
] }
const value = { user, nonce, issuedAt: Date.now() }
const signature = await signer.signTypedData(domain, types, value)
```

사용자 지갑에 "어느 사이트의, 어떤 목적의 서명인지" 명확히 표시됨 → 피싱 저항.

### 4. Nonce + 만료시간 + 체인ID

서명된 메시지·거래를 **한 번만 유효**하게:

```js
// 서버에서 nonce 발급 → 클라이언트 서명 → 서버 검증 후 폐기
const nonce = crypto.randomBytes(32).toString('hex')
await redis.set(`nonce:${userAddress}`, nonce, { EX: 300 })  // 5분 TTL

// 클라이언트가 이 nonce + chainId + expiresAt 포함해 서명
// 서버는 검증 후 redis에서 nonce 삭제 → 재사용 불가
```

### 5. 스마트 컨트랙트 보안 체크리스트 (솔리디티 기본)

```solidity
// ❌ reentrancy
function withdraw() external {
  uint256 amount = balances[msg.sender];
  (bool ok, ) = msg.sender.call{value: amount}("");
  balances[msg.sender] = 0;  // ← 송금 후 0으로. 공격자가 fallback에서 재호출 가능
}

// ✅ checks-effects-interactions + ReentrancyGuard
function withdraw() external nonReentrant {
  uint256 amount = balances[msg.sender];
  require(amount > 0, "zero");
  balances[msg.sender] = 0;  // effects 먼저
  (bool ok, ) = msg.sender.call{value: amount}("");  // interactions 마지막
  require(ok, "transfer failed");
}
```

기본 방어:
- `ReentrancyGuard` (OpenZeppelin) 상태 변경 함수에
- `require` / `revert`로 입력 검증
- 정수 오버플로우는 Solidity 0.8+에서 기본 방어, 하지만 `unchecked { }` 블록 주의
- `tx.origin` 대신 `msg.sender` 인증
- `call` 반환값 반드시 확인

### 6. Front-running / MEV 방어

```
문제: 내가 DEX에 토큰 구매 tx 올리면, MEV 봇이 mempool에서 보고 먼저 구매 → 가격 올린 뒤 나한테 비싸게 팔고 즉시 dump (샌드위치 공격)

방어:
- Slippage 설정 (최소 받을 토큰 수) 엄격히
- Flashbots / MEV-Blocker 같은 private mempool
- Deadline 짧게 (5분 이내)
```

### 7. 지갑 연결 플로우 권한 최소

```ts
// ❌ 연결하자마자 eth_accounts 외에 다른 권한도 함께 요청
await wallet.request({ method: 'eth_requestAccounts' })
await wallet.request({ method: 'wallet_addEthereumChain', params: [...] })

// ✅ 단계별 명시적 동의
// 1. 계정 연결
await wallet.request({ method: 'eth_requestAccounts' })
// 2. 다른 체인 추가는 사용자가 명시적으로 "다른 네트워크 사용" 선택 시에만
```

### 8. 컨트랙트 배포 전 감사

- **작은 규모(<$100k TVL)**: [Slither](https://github.com/crytic/slither), [Mythril](https://github.com/Consensys/mythril) 정적 분석 + 친구 개발자 리뷰
- **중간 규모**: [Code4rena](https://code4rena.com) / [Sherlock](https://www.sherlock.xyz) audit contest
- **대규모**: Trail of Bits, OpenZeppelin, Consensys Diligence 같은 감사 업체
- **배포 후**: Immunefi 버그 바운티 프로그램

"나는 신중한 개발자라 괜찮아요" — 역사상 수많은 프로젝트가 이렇게 믿다가 수백억 잃었습니다.

## AI에게 시킬 때 덧붙일 프롬프트

````
Web3 / dApp / 스마트 컨트랙트 코드 작성 시 다음 규칙:

1. Private key·mnemonic은 어디에도 평문 저장 금지. 서버가 서명해야 하면
   AWS KMS / HashiCorp Vault. dApp이면 사용자 지갑(MetaMask/WalletConnect)
   에 위임하고 우리는 key를 보지 않음.
2. 토큰 approve는 필요 금액만. 무한 승인(type(uint256).max) 권장하지 않음.
3. 서명 메시지는 EIP-712 typed data 사용. domain(name, version, chainId,
   verifyingContract) 명시.
4. 서명된 메시지에 nonce + expiresAt + chainId 포함, 서버가 한 번 쓰고 폐기.
5. 스마트 컨트랙트는 OpenZeppelin의 ReentrancyGuard, SafeERC20, Ownable
   등 검증된 라이브러리 사용. 자체 구현 최소화.
6. checks-effects-interactions 패턴 엄수. 외부 호출은 상태 변경 뒤에.
7. DEX/스왑 트랜잭션은 slippage bound + deadline 5분 이내.
8. 배포 전 Slither + Mythril 정적 분석. 가능하면 코드 감사(audit).
9. 사용자에게 승인 요청 UI에서 "어떤 컨트랙트에, 얼마를" 명확히 표시.
10. 프로덕션 컨트랙트는 상수 시그널 감시(가격 급변, 이상 tx 패턴)에
    Tenderly / Forta 같은 모니터링 연결.
````

## 지뢰 10개

1. **Private key `.env` 커밋** — 즉시 잔액 제로
2. **Mnemonic을 프론트 localStorage** — XSS 한 번에 전 유저 자금 이동
3. **approve MAX 권장** — 해당 컨트랙트 손상 시 전 잔액 취약
4. **plain string 서명 요청** — 피싱 서명 구분 불가
5. **nonce / expiresAt 없는 서명** — replay 가능
6. **Reentrancy 보호 없음** — 클래식 DAO 해킹 재현
7. **`tx.origin` 사용** — 피싱 컨트랙트 경유 우회
8. **Slippage 무제한 스왑** — MEV 샌드위치에 털림
9. **`call` 반환값 무시** — 실패한 송금이 성공으로 기록
10. **감사 없이 메인넷 배포** — 회수 불가능한 손실

## 머지 전 체크리스트

- [ ] Private key는 KMS/Vault/지갑에만. 코드·env·DB에 평문 없음
- [ ] 토큰 approve는 필요 금액만
- [ ] 서명은 EIP-712 typed data
- [ ] Nonce + expiresAt + chainId 검증
- [ ] 스마트 컨트랙트에 ReentrancyGuard
- [ ] checks-effects-interactions 패턴
- [ ] `tx.origin` 사용 없음
- [ ] 외부 `call` 반환값 검증
- [ ] Slippage + deadline 설정된 DEX 호출
- [ ] Slither / Mythril 정적 분석 통과
- [ ] 테스트넷에서 일정 기간 베타 테스트
- [ ] 일정 TVL 이상이면 audit contest 또는 전문 감사
- [ ] Immunefi 등 버그 바운티 프로그램 공지
- [ ] 배포 후 Tenderly / Forta 모니터링 설정
- [ ] Upgradeable 패턴이면 timelock + multisig로 upgrade 통제

## 참고
- OpenZeppelin Contracts: https://docs.openzeppelin.com/contracts
- SWC Registry (취약점 분류): https://swcregistry.io/
- Ethereum Smart Contract Best Practices: https://consensys.github.io/smart-contract-best-practices/
- Immunefi Bug Bounties: https://immunefi.com
- EIP-712: https://eips.ethereum.org/EIPS/eip-712
