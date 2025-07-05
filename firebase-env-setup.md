# Firebase Functions 환경변수 설정 가이드

## 1. 로컬 개발용 .env 파일 수정

`phone/.env` 파일을 다음과 같이 수정하세요:

```env
SPREADSHEET_ID=your_google_sheets_id_here
OPENAI_API_KEY=your_openai_api_key
GOOGLE_APPLICATION_CREDENTIALS=path/to/your/google-credentials.json
```

## 2. Firebase Functions 환경변수 설정 (프로덕션)

### 방법 1: Firebase CLI 사용

```bash
cd phone

# Google Sheets ID 설정
firebase functions:config:set spreadsheet.id="1BvHpZpL4lP2iZF_5VD8jNhLR9VgQCKS6eXjYfZaHgBc"

# OpenAI API Key 설정
firebase functions:config:set openai.api_key="your_openai_api_key"

# 설정 확인
firebase functions:config:get

# 배포
firebase deploy --only functions
```

### 방법 2: Google Cloud Console 사용

1. Google Cloud Console 접속
2. Cloud Functions 섹션 이동
3. phonePrice 함수 선택
4. 환경변수 탭에서 설정

## 3. 로컬 테스트 (에뮬레이터)

```bash
cd phone
npm run serve
```

## 4. 배포 후 테스트

```bash
# GET 방식 테스트
curl "https://us-central1-test-81c4f.cloudfunctions.net/phonePrice?question=갤럭시%20S25%20256%20SK%20번호이동%20얼마예요?"

# POST 방식 테스트
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"question": "갤럭시 S25 256 SK 번호이동 얼마예요?"}' \
  https://us-central1-test-81c4f.cloudfunctions.net/phonePrice
```

## 5. 주의사항

-   Google Credentials JSON 파일은 Firebase Functions에서 자동으로 관리됩니다
-   로컬 개발 시에만 GOOGLE_APPLICATION_CREDENTIALS 경로 설정 필요
-   프로덕션에서는 Firebase 서비스 계정이 자동으로 사용됩니다

## 6. 문제 해결

```bash
# 로그 확인
firebase functions:log

# 환경변수 확인
firebase functions:config:get

# 에뮬레이터 디버깅
firebase emulators:start --only functions --inspect-functions
```
