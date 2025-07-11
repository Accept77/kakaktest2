# 휴대폰 가격 조회 API - Firebase Functions

Google Sheets 데이터를 기반으로 휴대폰 가격을 조회하는 서버리스 API입니다.

## 🚀 배포 방법

### 1. Firebase CLI 설치

```bash
npm install -g firebase-tools
```

### 2. Firebase 로그인

```bash
firebase login
```

### 3. Firebase 프로젝트 초기화

```bash
firebase init functions
```

### 4. 환경변수 설정

```bash
# Google Sheets API 관련
firebase functions:config:set sheets.id="YOUR_SPREADSHEET_ID"
firebase functions:config:set google.credentials="path/to/credentials.json"

# OpenAI API 키
firebase functions:config:set openai.api_key="YOUR_OPENAI_API_KEY"
```

### 5. 배포

```bash
npm run deploy
```

## 🔧 로컬 개발

### 1. 의존성 설치

```bash
npm install
```

### 2. 환경변수 설정 (.env 파일)

```env
SPREADSHEET_ID=your_google_sheets_id
GOOGLE_APPLICATION_CREDENTIALS=path/to/credentials.json
OPENAI_API_KEY=your_openai_api_key
```

### 3. Firebase 에뮬레이터 실행

```bash
npm run serve
```

## 📡 API 사용법

### HTTP 엔드포인트

```
POST https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/phonePrice
GET https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/phonePrice?question=질문내용
```

### 요청 예시

#### GET 방식

```bash
curl "https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/phonePrice?question=갤럭시%20S25%20256%20SK%20번호이동%20얼마예요?"
```

#### POST 방식

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"question": "갤럭시 S25 256 SK 번호이동 얼마예요?"}' \
  https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/phonePrice
```

### 응답 형식

```json
{
    "question": "갤럭시 S25 256 SK 번호이동 얼마예요?",
    "scenario": "FULL_CONDITION",
    "answer": "📱 갤럭시 S25 256GB SK 번호이동 조건을 안내드려요:\n\n..."
}
```

## 🎯 지원하는 질문 유형

1. **전체 조건**: "갤럭시 S25 256 SK 번호이동 얼마예요?"
2. **통신사별**: "갤럭시 S25 256 SK 얼마예요?"
3. **모델별**: "갤럭시 S25 256 얼마예요?"
4. **브랜드별**: "갤럭시 얼마예요?"
5. **비교 질문**: "SK와 KT 중 어디가 더 저렴한가요?"
6. **비정형 질문**: "s25플 SK", "아이폰 프맥 256" 등

## 🔐 보안 설정

Firebase Functions 환경변수는 자동으로 암호화되어 저장됩니다.

## 💰 비용

-   Firebase Functions: 요청당 과금 (월 200만 호출까지 무료)
-   Google Sheets API: 일일 100회까지 무료
-   OpenAI API: 사용량에 따라 과금

## 🛠️ 문제 해결

### 로그 확인

```bash
npm run logs
```

### 로컬 테스트

```bash
firebase emulators:start --only functions
```

### 환경변수 확인

```bash
firebase functions:config:get
```
