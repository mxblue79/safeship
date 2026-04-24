# 모바일 앱 보안 가이드

> 대상: React Native / Flutter / Swift / Kotlin 앱 개발.
> 웹과 다른 고유 리스크: **앱 번들이 사용자 기기에 설치된다**는 점. 디컴파일로 전부 추출됩니다.

## 왜 웹과 다르게 위험한가

웹은 서버가 내 통제 하에 있지만, 모바일 앱은:
- **앱 번들(APK/IPA) 자체가 사용자 손에** → 디컴파일로 코드·문자열 전부 추출
- 공식 스토어 업로드본을 누구나 다운로드 가능 → 전 세계 리버스 엔지니어링 대상
- 업데이트 강제 못 함 → 취약한 구버전 앱이 계속 사용됨
- 사용자가 **기기를 루팅/탈옥**하면 앱 보호 장치 우회 가능
- 오프라인 동작 → 로컬 저장소에 민감 데이터 쌓임

## 피해 실예

- **APK 역디컴파일 → API 키 탈취**: Kotlin 코드에 `val API_KEY = "sk-..."` → `apktool` 한 줄로 추출 → 청구서 폭탄
- **Firebase 설정 그대로 공개**: `google-services.json` 번들에 포함 + Firestore RLS 없음 → 전 유저 데이터 접근 가능
- **HTTPS 중간자 공격**: SSL Pinning 없는 앱 → 공격자가 공용 Wi-Fi에서 proxy로 트래픽 복호화·변조
- **로컬 DB 평문**: SQLite/Realm에 비밀번호 평문 저장 → 탈옥 기기에서 파일 복사
- **딥링크 악용**: `myapp://pay?amount=0.01&to=attacker` 같은 스킴 링크를 공격자가 유도 → 의도 확인 없이 결제 실행
- **탈옥 기기에서 인앱 결제 우회**: `Receipt validation` 클라이언트만 체크 → 가짜 영수증으로 프리미엄 획득

## 핵심 원칙 8가지

### 1. 시크릿은 절대 번들에 넣지 않음

```kotlin
// ❌ apktool로 5초 만에 추출
const val OPENAI_KEY = "sk-proj-xxxxxxxxxx"
const val STRIPE_KEY = "sk_live_xxxxxxxx"

// ❌ BuildConfig도 마찬가지 (오히려 발견 더 쉬움)
// build.gradle
buildConfigField("String", "API_KEY", "\"${localProperties.getProperty('API_KEY')}\"")

// ✅ 시크릿 자체를 넣지 말고 백엔드 프록시
// 앱은 내 서버만 호출, 서버가 OpenAI/Stripe로 위임
```

React Native 예시:
```ts
// ❌ Expo의 .env도 결국 JS 번들에 포함
process.env.OPENAI_KEY  // metro가 빌드 시 inlining

// ✅ 서버 프록시
await fetch(`${SERVER_URL}/api/chat`, {
  headers: { Authorization: `Bearer ${userAuthToken}` },
  body: JSON.stringify({ messages })
})
```

Flutter도 동일 — `.env` 패키지 쓰면 asset bundle에 들어가 추출 가능.

**예외**: 진짜 공개해도 되는 값(Google Maps API key는 패키지명 제한으로 안전, Firebase API key도 RLS·App Check로 보호되면 OK)만 번들에 넣기.

### 2. Keychain (iOS) / Keystore (Android) 사용

사용자별 토큰·비밀번호는 **OS 수준 보안 저장소**에:

```swift
// iOS Keychain
let keychain = KeychainAccess.Keychain(service: "com.myapp.auth")
try keychain.set(token, key: "sessionToken")
```

```kotlin
// Android EncryptedSharedPreferences
val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
val prefs = EncryptedSharedPreferences.create(context, "secure_prefs", masterKey, ...)
prefs.edit().putString("token", token).apply()
```

React Native:
```ts
import * as Keychain from 'react-native-keychain'
await Keychain.setGenericPassword('user', token)
const creds = await Keychain.getGenericPassword()
```

**절대 하지 말 것**:
- `AsyncStorage` / `SharedPreferences`에 평문 토큰 저장
- SQLite에 비밀번호 평문 저장
- `UserDefaults` / `NSUserDefaults`에 민감 데이터

### 3. SSL Pinning (선택이지만 강력히 권장)

기본 HTTPS는 **시스템 루트 인증서를 신뢰**합니다. 공격자가 기기에 가짜 루트 인증서 설치(또는 기업 MDM 악용)하면 트래픽 복호화 가능.

Pinning은 "이 앱은 오직 우리 서버의 특정 인증서만 신뢰" 강제:

```kotlin
// Android OkHttp
val pinner = CertificatePinner.Builder()
  .add("api.myapp.com", "sha256/AAAAAA...")
  .build()
val client = OkHttpClient.Builder().certificatePinner(pinner).build()
```

```ts
// React Native — react-native-ssl-pinning
fetch('https://api.myapp.com', {
  sslPinning: { certs: ['mycert'] }
})
```

**주의**: pin된 인증서가 만료되면 앱이 일제히 통신 실패. 두 개 pin(primary + backup) + 인증서 갱신 일정 관리 필수.

### 4. 최소 권한 요청

```xml
<!-- ❌ 아무 기능 없이 전부 요청 -->
<uses-permission android:name="android.permission.READ_CONTACTS" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />

<!-- ✅ 실제 사용하는 것만 -->
<uses-permission android:name="android.permission.CAMERA" />  <!-- QR 스캔 기능 실제 사용 -->
```

Apple과 Google 심사에서 **사용 사유 없는 권한은 리젝트**. 그리고 권한이 많을수록 탈옥/악성 기기에서 추출할 데이터도 많음.

iOS는 `Info.plist`에 각 권한별 `UsageDescription` 명시 필수:
```xml
<key>NSCameraUsageDescription</key>
<string>QR 코드 스캔에 사용됩니다</string>
```

### 5. 딥링크 / Universal Link 검증

```
myapp://pay?amount=100&to=bank  ← 누구나 이 링크로 앱 열 수 있음
```

앱이 딥링크 받으면 **반드시 의도 확인 UI**:

```tsx
// ❌ 받자마자 실행
onDeepLink(url => {
  if (url.action === 'pay') executePayment(url.params)
})

// ✅ 사용자 확인 받기
onDeepLink(url => {
  if (url.action === 'pay') {
    navigation.navigate('ConfirmPayment', { params: url.params })
    // 사용자가 직접 "결제" 버튼 터치해야 실제 실행
  }
})
```

Android는 `App Links`, iOS는 `Universal Links`로 **도메인 소유권 검증된 딥링크**만 받도록 설정. 임의 스킴 딥링크(myapp://)는 타 앱이 훔칠 수 있음.

### 6. 인앱 결제 영수증 검증은 서버에서

```
❌ 클라이언트에서 receipt.success 체크 → DB에 프리미엄 기록
✅ 클라이언트가 receipt를 서버로 전송 → 서버가 Apple/Google 공식 API로 검증 → DB 기록
```

탈옥/루트 기기에서는 클라이언트 측 영수증 위조가 쉽습니다. 서버 검증이 유일한 방어:

```ts
// 서버에서
// Apple App Store
const verifyApple = async (receipt: string) => {
  const resp = await fetch('https://buy.itunes.apple.com/verifyReceipt', {
    method: 'POST',
    body: JSON.stringify({
      'receipt-data': receipt,
      password: process.env.APPLE_SHARED_SECRET
    })
  })
  const data = await resp.json()
  return data.status === 0  // 0 = valid
}

// Google Play
// Google Play Developer API + service account 필요
```

### 7. 탈옥/루트 감지 (선택)

금융·의료 앱이면 고려. 일반 앱은 과도.

```ts
// React Native — jail-monkey
import JailMonkey from 'jail-monkey'
if (JailMonkey.isJailBroken()) {
  // 정책: 기능 제한 / 경고 / 차단 중 선택
}
```

**주의**: 탈옥 감지는 우회 가능한 방어. 완벽하지 않음. 실제 방어는 **"탈옥 기기에서도 서버가 신뢰할 수 없는 데이터"로 설계**하는 것.

### 8. 빌드 시 코드 난독화

난독화는 **보안이 아니라 시간 벌기**입니다. 분석에 추가 시간이 걸리게 해서 캐주얼 공격 차단.

```kotlin
// Android — build.gradle release 구성
android {
  buildTypes {
    release {
      minifyEnabled true       // R8 활성화
      shrinkResources true
      proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
    }
  }
}
```

```
# iOS — Xcode Release scheme
SWIFT_OPTIMIZATION_LEVEL = -O
STRIP_STYLE = all
```

React Native: `Metro`의 기본 minify + Hermes 바이트코드 사용.

## AI에게 시킬 때 덧붙일 프롬프트

````
모바일 앱 코드 작성 시 다음 규칙:

1. API 키·시크릿은 어떤 형태로도 앱 번들에 넣지 않음. BuildConfig, .env,
   Info.plist, Android resources 전부 금지. 외부 API는 반드시 내 서버 경유.
2. 사용자별 토큰은 Keychain(iOS)/Keystore·EncryptedSharedPreferences(Android),
   React Native는 react-native-keychain 사용. AsyncStorage 평문 금지.
3. HTTPS 통신에 SSL Pinning 적용 (예외: 개발 환경). 주 인증서 + 백업 인증서
   2개로 pin하고 만료 전 갱신 계획 수립.
4. 권한은 실제 사용 기능만 요청. 모든 권한에 명확한 사유 문자열.
5. 딥링크는 받는 즉시 실행하지 않고 "사용자 확인 화면" 경유. 결제·인증 같은
   민감 액션은 더욱 엄격히.
6. 인앱 결제(IAP)는 receipt를 서버로 보내서 Apple/Google 공식 API로 검증.
   클라이언트 측 receipt 성공 판정만으로 프리미엄 부여 금지.
7. 릴리스 빌드에 code minify + obfuscation(ProGuard/R8, Swift -O) 활성화.
8. 로컬 DB에 민감 데이터 저장 시 SQLCipher 등으로 암호화.
9. 로그에 토큰·카드번호·이메일 전체 남기지 말 것. Crashlytics/Sentry에
   beforeSend 마스킹 필수.
````

## 지뢰 10개

1. **`const val API_KEY = "..."`** — apktool로 즉시 추출
2. **`.env` 파일을 React Native/Flutter에 번들링** — JS/Dart 번들에 문자열 포함
3. **`google-services.json` + Firestore RLS 없음** — 전 DB 접근 가능
4. **AsyncStorage에 JWT 토큰 평문 저장** — 탈옥 기기에서 읽힘
5. **SSL Pinning 없음** — Charles Proxy로 트래픽 전수조사 가능
6. **딥링크로 결제 즉시 실행** — 피싱 링크 한 번에 돈 잃음
7. **클라이언트에서 IAP 영수증 "성공" 판정** — 탈옥 기기에서 가짜 영수증 생성
8. **불필요한 권한 (`READ_SMS`, `READ_CALL_LOG`, `ACCESS_FINE_LOCATION`)** — 스토어 리젝트 + 사용자 불신
9. **Debug 빌드 설정으로 스토어 업로드** — `android:debuggable="true"`, `NSAllowsArbitraryLoads`
10. **디버그 로그에 전체 request/response** — Logcat/Console에서 토큰·카드번호 유출

## 머지 전 체크리스트

- [ ] 빌드된 APK를 `apktool`로 디컴파일, 시크릿 검색 → 결과 없음
  ```bash
  apktool d app-release.apk -o out
  grep -r "sk_live\|AKIA\|-----BEGIN" out/
  ```
- [ ] iOS IPA도 동일 (`class-dump`, `strings`)
  ```bash
  strings MyApp.app/MyApp | grep -E "sk_live|sk-proj|AKIA"
  ```
- [ ] `AsyncStorage`/`SharedPreferences`에 평문 토큰 없음
- [ ] 토큰은 Keychain/Keystore에만 저장
- [ ] HTTPS만 사용 (`NSAllowsArbitraryLoads=false`, `cleartextTrafficPermitted=false`)
- [ ] SSL Pinning 활성 (또는 의도적으로 비활성이면 사유 문서화)
- [ ] 권한 목록에 미사용 권한 없음
- [ ] 모든 권한에 사용 사유 문자열
- [ ] 딥링크·Universal Link에 의도 확인 UI
- [ ] IAP 영수증 서버 검증
- [ ] 릴리스 빌드에 minify + obfuscation
- [ ] `android:debuggable="false"`, `NSAllowsArbitraryLoads=false`
- [ ] Crashlytics/Sentry에 PII 마스킹(`beforeSend`)
- [ ] 앱 심사 지침의 개인정보처리방침 링크 유효

## 참고
- OWASP MASVS: https://mas.owasp.org/MASVS/
- OWASP Mobile Top 10: https://owasp.org/www-project-mobile-top-10/
- Android Security Best Practices: https://developer.android.com/topic/security/best-practices
- iOS Security: https://support.apple.com/guide/security/welcome/web
- React Native Security: https://reactnative.dev/docs/security
