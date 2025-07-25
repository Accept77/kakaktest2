# 휴대폰 가격 조회 API

Firebase Functions 기반의 서버리스 API입니다.  
Google Sheets 데이터를 활용해 휴대폰 가격을 조회할 수 있습니다.

## 사용 방법

### GET 요청

```bash
curl "https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/phonePrice?q=갤럭시%20S25%20256%20SK%20번호이동%20얼마예요?"
```

### POST 요청

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"query": "갤럭시 S25 256 SK 번호이동 얼마예요?"}' \
  https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/phonePrice
```

### 응답 예시

```json
{
    "query": "갤럭시 S25 256 SK 번호이동 얼마예요?",
    "response": "📱 갤럭시 S25 256GB SK 번호이동 조건을 안내드려요:\n\n💰 온라인 채널:\n• 요금제: 55,000원\n• 기기값: 850,000원\n\n🏢 내방 채널:\n• 요금제: 55,000원\n• 기기값: 820,000원"
}
```

## 지원하는 질문 유형

-   특정 모델 + 용량 + 통신사 + 타입: "아이폰 16 256 KT 번호이동"
-   브랜드별 비교: "갤럭시 S25 SK KT 어디가 더 저렴해?"
-   간단한 질문: "아이폰 16 얼마야?"
