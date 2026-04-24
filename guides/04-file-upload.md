# 파일 업로드 보안 가이드

> 대상: 이미지 / 문서 / 엑셀 / 로고 / 동영상 업로드 기능 구현할 때.
> "파일을 받아서 저장만 하면 되겠지" 수준으로 구현하면 RCE·XSS·스토리지 탈취가 한 번에 뚫립니다.

## 왜 자주 터지나

업로드는 **"사용자가 임의 바이너리를 내 서버에 올리는 행위"**라는 본질을 AI가 자주 놓칩니다. 기본 구현은 확장자만 대충 보고 저장하는 구조인데, 그 한 줄 차이로 서버 전체가 뚫립니다.

## 피해 실예

- **PHP 업로드 허용**: 이미지인 줄 알고 `.php` 허용 → 공격자가 웹셸 업로드 → 전체 서버 RCE
- **SVG XSS**: 로고 업로드에 SVG 받음 → `<script>` 내장된 SVG로 프로필 보는 사람마다 세션 탈취
- **Path traversal**: 파일명 `../../../etc/passwd` 그대로 저장 → 시스템 파일 덮어씀
- **스토리지 public 설정**: S3 버킷을 Public Read로 → 전 사용자 업로드 파일 인덱싱 가능
- **크기 제한 없음**: 100GB 파일 업로드로 디스크 꽉 채워 서비스 다운
- **악성 PDF**: 내장 JS 실행되는 PDF 배포 → 클라이언트 측 악용

## 핵심 원칙 6가지

### 1. MIME + 확장자 + 매직넘버 3중 검증

```ts
import { fileTypeFromBuffer } from 'file-type'

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp'])
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])

// ① 크기 확인
if (file.size > 5 * 1024 * 1024) throw new Error('Too large')

// ② 확장자 화이트리스트
const ext = path.extname(file.originalname).toLowerCase()
if (!ALLOWED_EXT.has(ext)) throw new Error('Bad extension')

// ③ 매직넘버 확인 (확장자 속이기 방어)
const buffer = await readFileBuffer(file)
const type = await fileTypeFromBuffer(buffer)
if (!type || !ALLOWED.has(type.mime)) throw new Error('Bad file type')

// ④ 브라우저가 파일 타입 sniffing 못하게
res.setHeader('X-Content-Type-Options', 'nosniff')
```

### 2. SVG는 거부하거나 sanitize

SVG는 **텍스트 포맷이고 `<script>` 실행 가능.** "이미지"라고 받으면 안 됩니다.

```ts
// ❌ accept="image/*" 는 SVG 포함
<input type="file" accept="image/*" />

// ✅ 명시 나열
<input type="file" accept="image/png, image/jpeg, image/webp" />

// 서버에서도 거부
if (type.mime === 'image/svg+xml') throw new Error('SVG not allowed')
```

반드시 SVG 허용해야 한다면 [DOMPurify](https://github.com/cure53/DOMPurify)로 sanitize:
```ts
import createDOMPurify from 'isomorphic-dompurify'
const sanitizedSvg = createDOMPurify.sanitize(svgContent, { USE_PROFILES: { svg: true, svgFilters: true } })
```

### 3. 파일명은 서버가 생성 (사용자 입력 신뢰 금지)

```ts
// ❌ 사용자가 보낸 이름 그대로 저장
fs.writeFile(`./uploads/${file.originalname}`, buffer)
// ../../../etc/passwd 가능, 덮어쓰기 가능

// ✅ UUID 또는 해시로 재명명
import { randomUUID } from 'crypto'
const filename = `${randomUUID()}${ext}`
fs.writeFile(`./uploads/${filename}`, buffer)
```

S3·Cloudflare R2 등 오브젝트 스토리지면 key를 서버가 생성하고 클라이언트에게 반환.

### 4. 업로드된 파일은 실행 안 되는 도메인에서 서빙

```
사용자 페이지:  https://myapp.com
업로드 파일:    https://cdn.myapp.com 또는 https://myapp-uploads.s3.amazonaws.com
```

같은 도메인에서 서빙하면 XSS가 세션 쿠키로 즉시 확장됩니다. 전용 서브도메인·스토리지로 분리.

그리고 `Content-Disposition: attachment` 헤더로 브라우저가 **실행 대신 다운로드**하게:
```ts
res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`)
res.setHeader('Content-Type', 'application/octet-stream')  // 의심스러운 건 바이너리로
```

### 5. 스토리지 권한 (S3·R2·Supabase Storage)

```
# ❌ 버킷 전체 Public Read + 파일명 추측 가능
s3://myapp-uploads/  → Public
파일명: user-123-avatar.png

# ✅ Public이 필요하면 CDN 경로만, 원본은 Private
# 파일명은 UUID → 추측 불가
s3://myapp-uploads/  → Private
CloudFront: myapp.com/cdn/<uuid> → Public via Origin Access Identity
```

사용자별 파일은 **Presigned URL**로 단기 접근:
```ts
const url = await s3.getSignedUrl('getObject', {
  Bucket: 'myapp',
  Key: file.key,
  Expires: 60 * 10  // 10분
})
```

### 6. 악성 콘텐츠 스캔 (선택)

민감한 서비스(파일 공유, 교육 플랫폼)면 ClamAV·VirusTotal API 통합:
```ts
const scan = await clamav.scan(buffer)
if (scan.isInfected) throw new Error('Malicious file')
```

## AI에게 시킬 때 덧붙일 프롬프트

````
파일 업로드 코드 작성 시 다음 규칙:

1. 허용 확장자·MIME을 화이트리스트로 명시. SVG·exe·php·html·svg는 기본 거부.
2. 서버에서 파일 매직넘버까지 확인(file-type 같은 라이브러리). 확장자만
   믿지 말 것.
3. 파일 크기 제한을 프론트·백엔드 양쪽에 적용. 프론트만으로 안 됨.
4. 파일명은 서버가 UUID+확장자로 재명명. 사용자 입력 파일명 그대로 저장 금지.
5. 업로드된 파일은 가능하면 별도 도메인(또는 CDN)에서 서빙. 같은 오리진에서
   서빙해야 한다면 Content-Disposition: attachment 헤더.
6. 스토리지 버킷은 기본 Private. Public 노출 필요하면 CDN via presigned URL
   또는 별도 퍼블릭 prefix만.
7. 응답에 X-Content-Type-Options: nosniff 필수.
````

## 지뢰 10개

1. **`accept="image/*"`** — SVG 포함, 브라우저 힌트일 뿐 보안 아님
2. **확장자만 검증, MIME 안 봄** — `evil.jpg.php` 같은 더블 확장자 통과
3. **파일명 그대로 사용** — path traversal, 덮어쓰기
4. **S3 버킷 Public Read** — 전 유저 파일 인덱싱
5. **같은 오리진에서 업로드 파일 서빙** — XSS → 세션 쿠키 탈취
6. **프론트에서만 크기 제한** — 공격자가 직접 POST로 우회
7. **SVG 허용** — 스크립트 내장 가능
8. **Presigned URL 만료 없음** — 영구 접근 가능
9. **업로드 처리 중 임시 파일 정리 안 함** — 디스크 꽉 참
10. **메타데이터 그대로 노출** — 이미지 EXIF에 GPS 좌표 → 스토커 위험

## 머지 전 체크리스트

- [ ] 확장자 화이트리스트 + MIME + 매직넘버 3중 검증
- [ ] SVG·html·js·exe·php 업로드 거부
- [ ] 파일명은 서버 생성(UUID/해시)
- [ ] 크기 제한 서버 측 (500KB ~ 10MB 범위, 기능에 맞게)
- [ ] 업로드 파일은 CDN/별도 도메인 또는 `Content-Disposition: attachment`
- [ ] 응답에 `X-Content-Type-Options: nosniff`
- [ ] S3·R2 버킷 기본 Private
- [ ] Presigned URL TTL 10분 이하
- [ ] 이미지면 EXIF 제거(sharp 등으로 re-encode)
- [ ] 로그에 파일 내용 남기지 않음 (파일명·크기·user_id만)

## 참고
- OWASP File Upload: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- file-type 라이브러리: https://github.com/sindresorhus/file-type
