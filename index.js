// index.js
import { google } from "googleapis";
import { OpenAI } from "openai";
import stringSimilarity from "string-similarity";
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { defineString, defineSecret } from "firebase-functions/params";

// Firebase Functions v2 Global Options 설정
setGlobalOptions({
    maxInstances: 10,
    region: "us-central1",
    memory: "1GiB",
    timeoutSeconds: 540,
});

// —————— 1) 환경 변수 & 상수 ——————
const spreadsheetId = defineString("SPREADSHEET_ID", {
    description: "Google Sheets ID for phone price data",
    default: "1baiOHh8zl7Zl44rgiZqD0tKlE428yk-Yr8R8k8XJC8w",
});

const openaiApiKey = defineSecret("OPENAI_API_KEY", {
    description: "OpenAI API key for natural language processing",
});

// 상수
const TELECOMS = ["SK", "KT", "LG"];
const TYPES = ["번호이동", "기기변경"];

// —————— 2) 클라이언트 초기화 ——————
const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

// OpenAI 클라이언트는 함수 내에서 초기화 (환경변수 접근 때문)

// —————— 3) 시트 데이터 파싱 ——————
async function parseFullSheetStructure(spreadsheetId) {
    const sheetNames = await listSheetNames(spreadsheetId);
    if (sheetNames.length === 0) {
        throw new Error("시트 목록을 가져올 수 없습니다.");
    }

    const allRecords = [];

    for (const sheetName of sheetNames) {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: `${sheetName}!A1:N100`,
            valueRenderOption: "UNFORMATTED_VALUE",
            dateTimeRenderOption: "FORMATTED_STRING",
        });
        const rows = res.data.values || [];

        if (rows.length < 3) continue;

        const sheetInfo = parseSheetInfo(sheetName);

        for (let i = 2; i < rows.length; i++) {
            const row = rows[i];
            if (!row[0] || row[0].trim() === "") continue;

            const serviceInfo = parseServiceInfo(row);

            // 번호이동 정보 (A, B, C, D열)
            if (row[0] && row[1] && row[3]) {
                allRecords.push({
                    modelRaw: row[0].trim(),
                    modelNorm: normalizeModelName(row[0].trim()),
                    capacity: normalizeCapacity(row[2]),
                    telecom: sheetInfo.telecom,
                    type: "번호이동",
                    channel: sheetInfo.channel,
                    plan: cleanPrice(row[1]),
                    price: cleanPrice(row[3]),
                    serviceInfo: serviceInfo,
                });
            }

            // 기기변경 정보 (F, G, H, I열)
            if (row[5] && row[6] && row[8]) {
                allRecords.push({
                    modelRaw: row[5].trim(),
                    modelNorm: normalizeModelName(row[5].trim()),
                    capacity: normalizeCapacity(row[7]),
                    telecom: sheetInfo.telecom,
                    type: "기기변경",
                    channel: sheetInfo.channel,
                    plan: cleanPrice(row[6]),
                    price: cleanPrice(row[8]),
                    serviceInfo: serviceInfo,
                });
            }
        }
    }

    return { allRecords };
}

// —————— 4) 유틸리티 함수들 ——————
async function listSheetNames(spreadsheetId) {
    try {
        const response = await sheets.spreadsheets.get({
            spreadsheetId: spreadsheetId,
        });
        return response.data.sheets.map((sheet) => sheet.properties.title);
    } catch (error) {
        console.error("시트 목록을 가져오는 데 실패했습니다:", error.message);
        return [];
    }
}

function parseSheetInfo(sheetName) {
    const telecom = sheetName.includes("SK")
        ? "SK"
        : sheetName.includes("KT")
        ? "KT"
        : sheetName.includes("LG")
        ? "LG"
        : "Unknown";

    const channel = sheetName.includes("온라인")
        ? "온라인"
        : sheetName.includes("내방")
        ? "내방"
        : "Unknown";

    return { telecom, channel };
}

function normalizeModelName(modelName) {
    return modelName
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/[^a-z0-9ㄱ-ㅎ가-힣]/g, "");
}

function normalizeCapacity(capacity) {
    if (!capacity || capacity === "") return "기본";

    // 숫자나 문자열을 문자열로 변환한 후 처리
    const capacityStr = capacity.toString().trim();
    if (capacityStr === "") return "기본";

    const numbers = capacityStr.match(/\d+/g);
    return numbers && numbers.length > 0 ? numbers[0] : "기본";
}

function cleanPrice(priceStr) {
    if (!priceStr) return "";
    return priceStr.toString().replace(/[^\d-]/g, "");
}

function parseServiceInfo(row) {
    // 실제 시트 구조에 맞게 수정: K~N열 (row[10]~row[13])
    if (row[10] && row[11] && row[12] && row[13]) {
        const serviceInfo = {
            serviceName: row[10].trim(), // K열: 부가서비스명
            monthlyFee: row[11], // L열: 월 청구금 (원본 유지)
            duration: row[12].trim(), // M열: 유지 기간
            additionalFee: cleanPrice(row[13]), // N열: 미가입 추가금
        };
        return serviceInfo;
    }
    return null;
}

// —————— 5) GPT 파싱 함수 ——————
async function parseUserInput(userInput, openaiApiKey) {
    try {
        const openai = new OpenAI({ apiKey: openaiApiKey });

        const prompt = `
사용자의 휴대폰 가격 문의를 분석하여 다음 정보를 추출해주세요:

사용자 입력: "${userInput}"

**추출 규칙:**
1. 브랜드: 갤럭시 또는 아이폰
2. 모델: 정확한 모델명 (예: S25, S25 PLUS, 16 PRO, 16 PRO Max)
3. 용량: 숫자만 (예: 128, 256, 512)
4. 통신사: SK, KT, LG 중 하나
5. 타입: 번호이동 또는 기기변경
6. 질문타입: 단순조회/비교질문/오타포함 중 하나
7. 원본추정: 오타나 축약어가 포함된 경우 추정되는 정확한 표현

**변환 규칙:**
- "프맥/프로맥스/16프맥" → "16 PRO Max"
- "울트라" → "ULTRA"
- "플/플러스" → "PLUS"
- "기변" → "기기변경"
- "번이" → "번호이동"
- "sk/SK" → "SK"
- 띄어쓰기 무시하고 파싱

**질문타입 판단:**
- 단순조회: 브랜드만 있거나 정상적인 모델명 문의 (예: "갤럭시", "갤럭시 폴드", "아이폰", "아이폰 16" 등)
- 비교질문: "뭐가 더 싸요?", "어디가 저렴한가요?", "vs", "비교" 등이 명시적으로 포함된 경우
- 오타포함: 띄어쓰기 없이 붙어있거나 심각한 축약어가 포함된 경우 (예: "갤럭시s25프맥", "아이폰16프맥")

**중요**: "갤럭시", "아이폰", "갤럭시 폴드" 같은 일반적인 브랜드나 모델명은 모두 "단순조회"로 분류하세요.

명시되지 않은 항목은 null로 설정해주세요.

JSON 형식으로만 답변:
{
  "브랜드": "갤럭시",
  "모델": "S25",
  "용량": "256",
  "통신사": "SK",
  "타입": "번호이동",
  "질문타입": "오타포함",
  "원본추정": "갤럭시 S25 256 SK 번호이동 얼마예요?"
}
`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content:
                        "휴대폰 가격 문의를 분석하는 전문가입니다. JSON 형식으로만 답변해주세요.",
                },
                {
                    role: "user",
                    content: prompt,
                },
            ],
            temperature: 0.1,
            max_tokens: 300,
        });

        let gptResponse = response.choices[0].message.content.trim();
        gptResponse = gptResponse.replace(/```json\s*\n?/g, "");
        gptResponse = gptResponse.replace(/```\s*$/g, "");
        gptResponse = gptResponse.trim();

        return JSON.parse(gptResponse);
    } catch (error) {
        console.error("GPT 파싱 오류:", error.message);
        return null;
    }
}

// —————— 6) 데이터 매칭 함수 ——————
function findMatchingRecords(parsedData, allRecords) {
    const { 브랜드, 모델, 용량, 통신사, 타입 } = parsedData;

    // 모델명도 브랜드도 없으면 빈 배열 반환
    if (!브랜드 && !모델) {
        return [];
    }

    // 검색 쿼리 생성
    let searchQuery = "";

    // 브랜드와 모델이 모두 있는 경우
    if (브랜드 && 모델 && 모델 !== 브랜드) {
        searchQuery = (브랜드 + " " + 모델).toLowerCase().replace(/\s+/g, "");
    }
    // 브랜드만 있는 경우
    else if (브랜드 && (!모델 || 모델 === 브랜드)) {
        searchQuery = 브랜드.toLowerCase().replace(/\s+/g, "");
    }
    // 모델명만 있는 경우 (브랜드 없이)
    else if (모델 && !브랜드) {
        searchQuery = 모델.toLowerCase().replace(/\s+/g, "");
    }

    // 용량이 없는 경우 - 입력된 키워드가 포함된 모든 모델들 검색
    if (!용량) {
        const availableModels = [...new Set(allRecords.map((r) => r.modelRaw))];

        // 입력된 키워드가 포함된 모든 모델명 찾기
        const matchingModels = availableModels.filter((modelName) => {
            const normalizedModel = modelName.toLowerCase().replace(/\s+/g, "");
            // 입력된 키워드가 실제 모델명에 포함되는지 확인
            return normalizedModel.includes(searchQuery);
        });

        const filteredRecords = allRecords.filter((r) =>
            matchingModels.includes(r.modelRaw)
        );

        // 브랜드만 있고 모델이 없는 경우에 대한 추가 필터링
        // 너무 많은 결과가 나오는 것을 방지하기 위해 결과 수 제한
        if (
            브랜드 &&
            (!모델 || 모델 === 브랜드) &&
            filteredRecords.length > 20
        ) {
            // 브랜드만 있는 경우, 최신 모델이나 인기 모델을 우선 표시
            const priorityKeywords = [
                "S25",
                "S24",
                "16",
                "15",
                "폴드",
                "fold",
                "플립",
                "flip",
                "울트라",
                "ultra",
            ];

            const priorityRecords = filteredRecords.filter((r) =>
                priorityKeywords.some((keyword) =>
                    r.modelRaw.toLowerCase().includes(keyword.toLowerCase())
                )
            );

            if (priorityRecords.length > 0 && priorityRecords.length <= 20) {
                return priorityRecords;
            }
        }

        return filteredRecords;
    }

    // 정확한 모델 매칭 (용량이 있는 경우)
    const availableModels = [...new Set(allRecords.map((r) => r.modelNorm))];
    const { bestMatch } = stringSimilarity.findBestMatch(
        searchQuery,
        availableModels
    );

    let matchingRecords = allRecords.filter(
        (r) => r.modelNorm === bestMatch.target
    );

    // 용량 필터링
    if (용량) {
        matchingRecords = matchingRecords.filter(
            (r) => r.capacity === 용량 || r.capacity === "기본"
        );
    }

    // 통신사 필터링
    if (통신사) {
        matchingRecords = matchingRecords.filter((r) => r.telecom === 통신사);
    }

    // 타입 필터링
    if (타입) {
        matchingRecords = matchingRecords.filter((r) => r.type === 타입);
    }

    return matchingRecords;
}

// —————— 7) 응답 생성 함수 ——————
function generateResponse(parsedData, matchingRecords) {
    const { 브랜드, 모델, 용량, 통신사, 타입, 질문타입, 원본추정 } = parsedData;

    // 5. 비교질문 처리
    if (질문타입 === "비교질문") {
        return formatComparisonGuide(parsedData);
    }

    // 브랜드만 있는 경우 (GPT가 오타포함으로 분류해도 강제로 모델명 검색 실행)
    if (브랜드 && (!모델 || 모델 === 브랜드)) {
        if (matchingRecords.length > 0) {
            return formatSimilarModels(matchingRecords, 브랜드, 모델 || "");
        }
    }

    // 모델명만 있는 경우 (브랜드 없이)
    if (모델 && !브랜드) {
        if (matchingRecords.length > 0) {
            return formatSimilarModels(matchingRecords, "", 모델);
        } else {
            return `"${모델}" 관련 정보를 찾을 수 없습니다.\n정확한 모델명을 입력해주세요.\n예: 갤럭시 S25, 아이폰 16`;
        }
    }

    // 6. 오타/비정형/축약어 포함 질문 처리 (브랜드도 모델도 없는 경우만)
    if (질문타입 === "오타포함" && !브랜드 && !모델) {
        return formatTypoGuide(parsedData, 원본추정);
    }

    if (!브랜드 && !모델) {
        return "죄송합니다. 모델명을 정확히 파악할 수 없습니다. 다시 말씀해주세요.\n예: 갤럭시 S25 256 SK 번호이동";
    }

    // 4단계 조건 분석
    // 1. 모델명만 있는 경우 → 유사 모델명 출력 후 유도
    if (!용량) {
        const displayBrand = 브랜드 || "";
        const displayModel = 모델 || "";
        return formatSimilarModels(matchingRecords, displayBrand, displayModel);
    }

    // 2. 모델명 + 용량 → 모든 통신사 조건 표시
    if (!통신사) {
        if (matchingRecords.length === 0) {
            const modelInfo = 브랜드
                ? `${브랜드} ${모델} ${용량}GB`
                : `${모델} ${용량}GB`;
            return `${modelInfo} 정보를 찾을 수 없습니다.\n정확한 모델명과 용량을 확인해주세요.`;
        }
        const modelInfo = 브랜드
            ? `${브랜드} ${모델} ${용량}GB`
            : `${모델} ${용량}GB`;
        return formatAllTelecomConditions(matchingRecords, modelInfo);
    }

    // 3. 모델명 + 용량 + 통신사 → 해당 통신사 조건 표시
    if (!타입) {
        if (matchingRecords.length === 0) {
            const modelInfo = 브랜드
                ? `${브랜드} ${모델} ${용량}GB ${통신사}`
                : `${모델} ${용량}GB ${통신사}`;
            return `${modelInfo} 정보를 찾을 수 없습니다.\n정확한 조건을 확인해주세요.`;
        }
        const modelInfo = 브랜드
            ? `${브랜드} ${모델} ${용량}GB ${통신사}`
            : `${모델} ${용량}GB ${통신사}`;
        return formatTelecomSpecificConditions(matchingRecords, modelInfo);
    }

    // 4. 모델명 + 용량 + 통신사 + 이동유형 → 해당 조건만 표시
    if (matchingRecords.length === 0) {
        const modelInfo = 브랜드
            ? `${브랜드} ${모델} ${용량}GB ${통신사} ${타입}`
            : `${모델} ${용량}GB ${통신사} ${타입}`;
        return `${modelInfo} 정보를 찾을 수 없습니다.\n정확한 조건을 확인해주세요.`;
    }
    const modelInfo = 브랜드
        ? `${브랜드} ${모델} ${용량}GB ${통신사} ${타입}`
        : `${모델} ${용량}GB ${통신사} ${타입}`;
    return formatSpecificCondition(matchingRecords, modelInfo);
}

// 1. 유사 모델명 포맷 (모델명만 있을 때)
function formatSimilarModels(records, 브랜드, 모델) {
    if (records.length === 0) {
        const searchTerm =
            브랜드 && 모델 ? `${브랜드} ${모델}` : 브랜드 || 모델 || "";
        return `${searchTerm} 관련 정보를 찾을 수 없습니다.\n정확한 모델명을 입력해주세요.\n예: 갤럭시 S25, 아이폰 16`;
    }

    // 검색된 모델명들을 브랜드별로 그룹화
    const uniqueModels = [...new Set(records.map((r) => r.modelRaw))];
    const galaxyModels = uniqueModels.filter(
        (m) => m.includes("갤럭시") || m.includes("Galaxy")
    );
    const iphoneModels = uniqueModels.filter(
        (m) => m.includes("아이폰") || m.includes("iPhone")
    );

    // 검색어 표시를 위한 텍스트 생성 - 실제 검색 결과를 분석하여 더 정확한 검색어 표시
    let searchTerm = "";

    // 검색 결과를 분석하여 공통 키워드 찾기
    if (galaxyModels.length > 0 && iphoneModels.length === 0) {
        // 갤럭시만 있는 경우 - 공통 키워드 찾기
        const commonKeywords = [
            "폴드",
            "fold",
            "플립",
            "flip",
            "울트라",
            "ultra",
            "플러스",
            "plus",
            "S25",
            "S24",
            "S23",
        ];
        const foundKeyword = commonKeywords.find((keyword) =>
            galaxyModels.some((model) =>
                model.toLowerCase().includes(keyword.toLowerCase())
            )
        );

        if (
            foundKeyword &&
            galaxyModels.every((model) =>
                model.toLowerCase().includes(foundKeyword.toLowerCase())
            )
        ) {
            // 모든 갤럭시 모델이 공통 키워드를 포함하는 경우
            searchTerm =
                foundKeyword.includes("fold") || foundKeyword.includes("폴드")
                    ? "폴드"
                    : foundKeyword.includes("flip") ||
                      foundKeyword.includes("플립")
                    ? "플립"
                    : foundKeyword.includes("ultra") ||
                      foundKeyword.includes("울트라")
                    ? "울트라"
                    : foundKeyword.includes("plus") ||
                      foundKeyword.includes("플러스")
                    ? "플러스"
                    : foundKeyword;
        } else {
            searchTerm =
                브랜드 && 모델 && 브랜드 !== 모델
                    ? `${브랜드} ${모델}`
                    : 브랜드
                    ? 브랜드
                    : 모델 || "갤럭시";
        }
    } else if (iphoneModels.length > 0 && galaxyModels.length === 0) {
        // 아이폰만 있는 경우 - 공통 키워드 찾기
        const commonKeywords = [
            "16",
            "15",
            "14",
            "13",
            "12",
            "pro",
            "프로",
            "max",
            "맥스",
            "plus",
            "플러스",
        ];
        const foundKeyword = commonKeywords.find((keyword) =>
            iphoneModels.some((model) =>
                model.toLowerCase().includes(keyword.toLowerCase())
            )
        );

        if (
            foundKeyword &&
            iphoneModels.every((model) =>
                model.toLowerCase().includes(foundKeyword.toLowerCase())
            )
        ) {
            // 모든 아이폰 모델이 공통 키워드를 포함하는 경우
            searchTerm =
                foundKeyword.includes("pro") || foundKeyword.includes("프로")
                    ? "프로"
                    : foundKeyword.includes("max") ||
                      foundKeyword.includes("맥스")
                    ? "맥스"
                    : foundKeyword;
        } else {
            searchTerm =
                브랜드 && 모델 && 브랜드 !== 모델
                    ? `${브랜드} ${모델}`
                    : 브랜드
                    ? 브랜드
                    : 모델 || "아이폰";
        }
    } else {
        // 혼합되어 있거나 기타 경우
        searchTerm =
            브랜드 && 모델 && 브랜드 !== 모델
                ? `${브랜드} ${모델}`
                : 브랜드
                ? 브랜드
                : 모델 || "";
    }

    let result = `🔍 "${searchTerm}" 검색 결과 (총 ${uniqueModels.length}개 모델):\n\n`;

    // 갤럭시 모델들
    if (galaxyModels.length > 0) {
        result += `📱 갤럭시 시리즈\n`;
        galaxyModels.slice(0, 8).forEach((modelName, index) => {
            // 해당 모델의 사용 가능한 용량들 찾기
            const modelRecords = records.filter(
                (r) => r.modelRaw === modelName
            );
            const capacities = [
                ...new Set(modelRecords.map((r) => r.capacity)),
            ].filter((c) => c && c !== "기본");
            const capacityText =
                capacities.length > 0 ? ` (${capacities.join(", ")}GB)` : "";

            result += `${index + 1}. ${modelName}${capacityText}\n`;
        });
        if (galaxyModels.length > 8) {
            result += `... 외 ${galaxyModels.length - 8}개 모델\n`;
        }
        result += `\n`;
    }

    // 아이폰 모델들
    if (iphoneModels.length > 0) {
        result += `📱 아이폰 시리즈\n`;
        iphoneModels.slice(0, 8).forEach((modelName, index) => {
            // 해당 모델의 사용 가능한 용량들 찾기
            const modelRecords = records.filter(
                (r) => r.modelRaw === modelName
            );
            const capacities = [
                ...new Set(modelRecords.map((r) => r.capacity)),
            ].filter((c) => c && c !== "기본");
            const capacityText =
                capacities.length > 0 ? ` (${capacities.join(", ")}GB)` : "";

            result += `${index + 1}. ${modelName}${capacityText}\n`;
        });
        if (iphoneModels.length > 8) {
            result += `... 외 ${iphoneModels.length - 8}개 모델\n`;
        }
        result += `\n`;
    }

    result += `💡 정확한 가격을 확인하시려면 용량과 함께 말씀해주세요.\n`;
    result += `예: "${uniqueModels[0]} 256GB 얼마예요?"`;

    return result;
}

// 2. 모든 통신사 조건 포맷 (모델명 + 용량)
function formatAllTelecomConditions(records, modelInfo) {
    const groupedByTelecom = groupByTelecom(records);
    let result = `📱 ${modelInfo} 전체 가격 조건을 안내드려요:\n\n`;

    // 통신사별로 처리
    ["SK", "KT", "LG"].forEach((telecom) => {
        if (groupedByTelecom[telecom]) {
            // 온라인 조건
            const onlineRecords = groupedByTelecom[telecom].filter(
                (r) => r.channel === "온라인"
            );
            if (onlineRecords.length > 0) {
                result += `📦 온라인 가격 조건 안내 (${telecom})\n\n`;
                result += formatTelecomConditions(onlineRecords);
            }

            // 내방 조건
            const offlineRecords = groupedByTelecom[telecom].filter(
                (r) => r.channel === "내방"
            );
            if (offlineRecords.length > 0) {
                result += `🏬 내방 가격 조건 안내 (${telecom})\n\n`;
                result += formatTelecomConditions(offlineRecords);
            }

            result += `\n`;
        }
    });

    return result.trim();
}

// 3. 특정 통신사 조건 포맷 (모델명 + 용량 + 통신사)
function formatTelecomSpecificConditions(records, modelInfo) {
    const telecom = records[0].telecom;

    let result = `📱 ${modelInfo} 조건을 안내드려요:\n\n`;

    // 온라인 조건
    const onlineRecords = records.filter((r) => r.channel === "온라인");
    if (onlineRecords.length > 0) {
        result += `📦 온라인 가격 조건\n\n`;
        const groupedByType = groupByType(onlineRecords);

        ["번호이동", "기기변경"].forEach((type) => {
            if (groupedByType[type]) {
                const record = groupedByType[type][0];
                result += formatDetailedCondition(record);
            }
        });
    }

    // 내방 조건
    const offlineRecords = records.filter((r) => r.channel === "내방");
    if (offlineRecords.length > 0) {
        result += `🏬 내방 가격 조건\n\n`;
        const groupedByType = groupByType(offlineRecords);

        ["번호이동", "기기변경"].forEach((type) => {
            if (groupedByType[type]) {
                const record = groupedByType[type][0];
                result += formatDetailedCondition(record);
            }
        });
    }

    return result.trim();
}

// 4. 특정 조건 포맷 (완전한 조건일 때)
function formatSpecificCondition(records, modelInfo) {
    const telecom = records[0].telecom;
    const type = records[0].type;

    let result = `📱 ${modelInfo} 조건을 안내드려요:\n\n`;

    // 온라인 조건
    const onlineRecord = records.find((r) => r.channel === "온라인");
    if (onlineRecord) {
        result += `📦 온라인 가격 조건\n\n`;
        result += formatDetailedCondition(onlineRecord);
    }

    // 내방 조건
    const offlineRecord = records.find((r) => r.channel === "내방");
    if (offlineRecord) {
        result += `🏬 내방 가격 조건\n\n`;
        result += formatDetailedCondition(offlineRecord);
    }

    return result;
}

// 5. 오타/비정형/축약어 포함 질문 유도 응답
function formatTypoGuide(parsedData, 원본추정) {
    const { 브랜드, 모델, 용량, 통신사, 타입 } = parsedData;

    let result = `📝 입력해주신 조건을 확인해보니 `;

    // 파악된 정보들 표시
    const detectedInfo = [];
    if (브랜드 && 모델) detectedInfo.push(`'${브랜드} ${모델}'`);
    if (용량) detectedInfo.push(`'${용량}GB'`);
    if (통신사) detectedInfo.push(`'${통신사}'`);
    if (타입) detectedInfo.push(`'${타입}'`);

    if (detectedInfo.length > 0) {
        result += detectedInfo.join(" 또는 ") + " 조건으로 보입니다 😊\n\n";
    }

    result += `정확한 가격 안내를 위해 아래처럼 말씀해주시면 더 빠르게 안내드릴 수 있어요:\n\n`;

    // 추정되는 정확한 표현 제시
    if (원본추정) {
        result += `💡 **추천 검색어:**\n`;
        result += `"${원본추정}"\n\n`;
    }

    result += `📋 **입력 형식 예시:**\n`;
    result += `• 아이폰 16 프로맥스 256 SK 번호이동 얼마예요?\n`;
    result += `• 갤럭시 S25 울트라 512 KT 기기변경\n`;
    result += `• 아이폰 15 128 LG 얼마예요?`;

    return result;
}

// 6. 비교질문 유도 응답
function formatComparisonGuide(parsedData) {
    const { 브랜드, 모델, 용량, 통신사, 타입 } = parsedData;

    let result = `🎯 말씀해주신 질문은 가격 비교가 필요한 상황으로 보여요 😊\n\n`;
    result += `정확한 비교를 위해 아래 정보를 함께 알려주시면 도와드릴게요:\n\n`;

    result += `📌 **필요한 정보:**\n`;
    result += `• 모델명 + 용량 (예: 아이폰 16 256GB)\n`;
    result += `• 통신사 (SK/KT/LG)\n`;
    result += `• 번호이동 or 기기변경\n`;
    result += `• 온라인 or 내방 희망 여부\n\n`;

    result += `💡 **검색 예시:**\n`;
    result += `• "아이폰 15 256 LG 번호이동은 얼마예요?"\n`;
    result += `• "갤럭시 S25 512 SK 기기변경"\n`;
    result += `• "아이폰 16 프로 128 KT"\n\n`;

    result += `📱 정확한 조건을 입력해주시면 최저가 정보를 찾아드려요!`;

    return result;
}

// 통신사별 조건 포맷
function formatTelecomConditions(records) {
    let result = "";
    const groupedByType = groupByType(records);

    ["번호이동", "기기변경"].forEach((type) => {
        if (groupedByType[type]) {
            const record = groupedByType[type][0];
            result += formatDetailedCondition(record);
        }
    });

    return result;
}

// 상세 조건 포맷
function formatDetailedCondition(record) {
    let result = `📱 ${record.telecom} ${record.type}\n`;
    result += `✅ 할부원금: ${formatPrice(record.price)}원\n`;

    // 요금제 정보 (요금제별 상세 조건 추가)
    const planDetails = getPlanDetails(record.telecom, record.plan);
    result += `✅ 요금제: 월 ${formatPrice(record.plan)}원${planDetails}\n`;

    // 실제 시트의 부가서비스 정보 사용
    if (record.serviceInfo) {
        result += `✅ 부가서비스\n`;
        result += ` - ${record.serviceInfo.serviceName}: ${formatPrice(
            record.serviceInfo.monthlyFee
        )}원\n`;
        result += ` - 유지기간: ${record.serviceInfo.duration}\n`;
        result += `❗ 미가입 시 추가금: +${formatPrice(
            record.serviceInfo.additionalFee
        )}원\n`;
    } else {
        // 부가서비스 정보가 없는 경우 기본 안내
        const serviceDetails = getServiceDetails(
            record.telecom,
            record.channel
        );
        if (serviceDetails) {
            result += serviceDetails;
        }
    }

    result += `\n`;
    return result;
}

// 요금제 상세 조건
function getPlanDetails(telecom, plan) {
    const planAmount = parseInt(plan);

    if (telecom === "SK") {
        if (planAmount >= 100000) {
            return " (187일 후 43,000원 이상 변경 가능)";
        }
    } else if (telecom === "KT") {
        if (planAmount >= 90000) {
            return "\n - 187일 후 47,000원 이상 요금제로 변경 가능";
        }
    } else if (telecom === "LG") {
        if (planAmount >= 115000) {
            return " (187일 후 47,000원 이상 변경 가능)";
        }
    }

    return "";
}

// 부가서비스 상세 정보
function getServiceDetails(telecom, channel) {
    let result = "";

    if (telecom === "SK") {
        if (channel === "온라인") {
            result += `✅ 부가서비스 (90일 유지)\n`;
            result += ` - 파손보험: 6,300원\n`;
            result += ` - 마이스마트콜3: 3,500원\n`;
            result += `❗ 부가 미가입 시\n`;
            result += ` - 마이스마트콜3 미가입: +1만원\n`;
            result += ` - 파손보험 미가입: +1만원\n`;
        } else {
            result += `✅ 부가서비스\n`;
            result += ` - 올케어+ (파손보험 포함)\n`;
            result += ` - 60일 유지 / 유지비 약 1만원\n`;
            result += `❗ 부가 미가입 시\n`;
            result += ` - 파손보험 미가입: +1만원\n`;
        }
    } else if (telecom === "KT") {
        if (channel === "온라인") {
            result += `✅ 부가서비스 (각 130일 유지)\n`;
            result += ` - 필수팩: 9,900원\n`;
            result += ` - 파손보험: 5,900원\n`;
            result += `❗ 부가 미가입 시\n`;
            result += ` - 필수팩 미가입: +5만원\n`;
            result += ` - 파손보험 미가입: +2만원\n`;
            result += ` - 전부 미가입 시 → 캐치콜(550원) 필수가입 / 30일 유지\n`;
        } else {
            result += `✅ 부가서비스\n`;
            result += ` 1. 필수팩 (9,900원) – 필수가입, 130일 유지\n`;
            result += ` 2. KT 신한카드 –\n`;
            result += `  - 발급 후 1주일 이내 자동이체 등록 필수 (실적 조건 없음)\n`;
            result += `  - 미가입 시 +5만원 추가금\n`;
        }
    } else if (telecom === "LG") {
        if (channel === "온라인") {
            result += `✅ 부가서비스 (각 100일 유지)\n`;
            result += ` 1. 유플레이프리미엄: 15,400원\n`;
            result += ` 2. 폰안심패스: 기종별 상이\n`;
            result += ` 3. 통화연결음 1곡: 1,540원\n`;
            result += `❗ 부가 미가입 시\n`;
            result += ` - 유플레이프리미엄: +3만원\n`;
            result += ` - 폰안심패스: +4만원\n`;
            result += ` - 통화연결음: 필수 가입, 100일 유지\n`;
        } else {
            result += `✅ 부가서비스 (각 100일 유지)\n`;
            result += ` 1. 유플레이프리미엄: 15,400원\n`;
            result += ` 2. V컬러링바이브: 8,800원\n`;
            result += ` 3. 폰안심패스: 기종별 상이\n`;
            result += `❗ 부가 미가입 시\n`;
            result += ` - 유플레이프리미엄: +5만원\n`;
            result += ` - V컬러링바이브: +3만원\n`;
            result += ` - 폰안심패스: +3만원\n`;
        }
    }

    return result;
}

// 그룹핑 함수들
function groupByTelecom(records) {
    const groups = {};
    records.forEach((record) => {
        if (!groups[record.telecom]) {
            groups[record.telecom] = [];
        }
        groups[record.telecom].push(record);
    });
    return groups;
}

function groupByType(records) {
    const groups = {};
    records.forEach((record) => {
        if (!groups[record.type]) {
            groups[record.type] = [];
        }
        groups[record.type].push(record);
    });
    return groups;
}

// 기존 groupRecords 함수는 새로운 그룹핑 함수들로 대체됨

function formatPrice(price) {
    if (!price || price === "0" || price === "") return "0";

    // 숫자가 아닌 문자열(예: "기종마다 상이")인 경우 그대로 반환
    if (isNaN(price)) {
        return price.toString();
    }

    return parseInt(price).toLocaleString();
}

// —————— 8) 메인 처리 함수 ——————
async function processUserQuery(userInput, openaiApiKey) {
    try {
        // 시트 데이터 가져오기
        const { allRecords } = await parseFullSheetStructure(
            spreadsheetId.value()
        );

        // 1. GPT로 사용자 입력 파싱
        const parsedData = await parseUserInput(userInput, openaiApiKey);
        console.log("GPT 파싱 결과:", JSON.stringify(parsedData));

        if (!parsedData) {
            return "죄송합니다. 질문을 이해할 수 없습니다. 다시 말씀해주세요.";
        }

        // 2. 매칭되는 레코드 찾기
        const matchingRecords = findMatchingRecords(parsedData, allRecords);
        console.log("매칭된 레코드 수:", matchingRecords.length);

        // 3. 특정 모델명 키워드 우선 처리 (GPT 파싱보다 우선) - 단, 용량이 있는 경우는 제외
        const lowerInput = userInput.toLowerCase();
        const hasCapacity =
            lowerInput.includes("256") ||
            lowerInput.includes("128") ||
            lowerInput.includes("512") ||
            lowerInput.includes("1tb") ||
            lowerInput.includes("64") ||
            lowerInput.includes("32");

        const specificKeywords = [
            { keyword: "폴드", english: "fold" },
            { keyword: "플립", english: "flip" },
            { keyword: "울트라", english: "ultra" },
            { keyword: "프로", english: "pro" },
            { keyword: "맥스", english: "max" },
            { keyword: "플러스", english: "plus" },
        ];

        // 특정 키워드가 있는지 확인 - 하지만 용량이 명시된 경우는 GPT 파싱 결과를 우선 사용
        const foundSpecificKeyword = !hasCapacity
            ? specificKeywords.find(
                  (item) =>
                      lowerInput.includes(item.keyword) ||
                      lowerInput.includes(item.english)
              )
            : null;

        if (foundSpecificKeyword) {
            console.log("특정 키워드 발견:", foundSpecificKeyword);

            const availableModels = [
                ...new Set(allRecords.map((r) => r.modelRaw)),
            ];

            // 해당 키워드가 포함된 모델들만 검색
            const keywordMatches = availableModels.filter((modelName) => {
                const normalizedModel = modelName
                    .toLowerCase()
                    .replace(/\s+/g, "");
                return (
                    normalizedModel.includes(foundSpecificKeyword.keyword) ||
                    normalizedModel.includes(foundSpecificKeyword.english)
                );
            });

            console.log(
                "키워드로 매칭된 모델명들:",
                keywordMatches.slice(0, 5)
            );

            const keywordRecords = allRecords.filter((r) =>
                keywordMatches.includes(r.modelRaw)
            );

            if (keywordRecords.length > 0) {
                console.log(
                    "특정 키워드 검색 성공:",
                    keywordRecords.length + "개 모델 발견"
                );
                return formatSimilarModels(
                    keywordRecords,
                    "",
                    foundSpecificKeyword.keyword
                );
            }
        }

        // 4. 브랜드 키워드가 있는 경우 직접 검색 (GPT 파싱 실패 시 또는 용량이 없을 때)
        const hasGalaxy =
            lowerInput.includes("갤럭시") || lowerInput.includes("galaxy");
        const hasIphone =
            lowerInput.includes("아이폰") || lowerInput.includes("iphone");

        // GPT 파싱에서 브랜드+모델이 모두 있는 경우, 매칭 레코드가 있으면 우선 사용
        if (
            parsedData.브랜드 &&
            parsedData.모델 &&
            parsedData.브랜드 !== parsedData.모델 &&
            matchingRecords.length > 0
        ) {
            console.log(
                "GPT 파싱 결과로 브랜드+모델 조합 검색 성공:",
                matchingRecords.length + "개 모델 발견"
            );
            const response = generateResponse(parsedData, matchingRecords);
            return response;
        }

        // 브랜드가 있고 용량이 없으며, GPT 파싱에서 모델이 제대로 설정되지 않은 경우에만 직접 검색
        if (
            (hasGalaxy || hasIphone) &&
            !hasCapacity &&
            !foundSpecificKeyword &&
            (!parsedData.브랜드 ||
                !parsedData.모델 ||
                parsedData.브랜드 === parsedData.모델 ||
                matchingRecords.length === 0)
        ) {
            console.log("브랜드 키워드 발견, 직접 검색 실행:", {
                hasGalaxy,
                hasIphone,
                hasCapacity,
            });

            const brandName = hasGalaxy ? "갤럭시" : "아이폰";
            const availableModels = [
                ...new Set(allRecords.map((r) => r.modelRaw)),
            ];

            // 브랜드 키워드로 직접 검색
            const directMatches = availableModels.filter((modelName) => {
                return modelName
                    .toLowerCase()
                    .includes(brandName.toLowerCase());
            });

            console.log("매칭된 모델명들:", directMatches.slice(0, 5));

            const directRecords = allRecords.filter((r) =>
                directMatches.includes(r.modelRaw)
            );

            if (directRecords.length > 0) {
                console.log(
                    "직접 브랜드 검색 성공:",
                    directRecords.length + "개 모델 발견"
                );
                return formatSimilarModels(directRecords, brandName, "");
            }
        }

        // 5. 모델명 키워드만 있는 경우 직접 검색 (브랜드 없이 모델명만 입력한 경우)
        if (
            !hasGalaxy &&
            !hasIphone &&
            !hasCapacity &&
            !foundSpecificKeyword &&
            matchingRecords.length === 0
        ) {
            console.log("모델명 키워드로 직접 검색 시도");

            // 일반적인 모델명 키워드들
            const modelKeywords = [
                "s25",
                "s24",
                "s23",
                "s22",
                "s21",
                "s20",
                "16",
                "15",
                "14",
                "13",
                "12",
                "11",
                "아이패드",
                "ipad",
                "워치",
                "watch",
            ];

            // 입력에서 모델명 키워드 찾기
            const foundKeywords = modelKeywords.filter((keyword) =>
                lowerInput.includes(keyword)
            );

            if (foundKeywords.length > 0) {
                console.log("발견된 모델명 키워드들:", foundKeywords);

                const availableModels = [
                    ...new Set(allRecords.map((r) => r.modelRaw)),
                ];

                // 발견된 키워드들로 모델 검색
                const directMatches = availableModels.filter((modelName) => {
                    const normalizedModel = modelName
                        .toLowerCase()
                        .replace(/\s+/g, "");
                    return foundKeywords.some((keyword) =>
                        normalizedModel.includes(keyword.replace(/\s+/g, ""))
                    );
                });

                console.log(
                    "키워드로 매칭된 모델명들:",
                    directMatches.slice(0, 5)
                );

                const directRecords = allRecords.filter((r) =>
                    directMatches.includes(r.modelRaw)
                );

                if (directRecords.length > 0) {
                    console.log(
                        "직접 모델명 키워드 검색 성공:",
                        directRecords.length + "개 모델 발견"
                    );
                    return formatSimilarModels(
                        directRecords,
                        "",
                        foundKeywords.join(" ")
                    );
                }
            }
        }

        // 6. 응답 생성
        const response = generateResponse(parsedData, matchingRecords);

        return response;
    } catch (error) {
        console.error("처리 중 오류:", error);
        return "죄송합니다. 서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
    }
}

// —————— 9) Firebase Functions 엔드포인트 ——————
export const phonePrice = onRequest(
    {
        invoker: "public",
        cors: true,
        secrets: [openaiApiKey],
    },
    async (req, res) => {
        try {
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Access-Control-Allow-Methods", "GET, POST");
            res.set("Access-Control-Allow-Headers", "Content-Type");

            if (req.method === "OPTIONS") {
                res.status(204).send("");
                return;
            }

            const question =
                req.method === "GET" ? req.query.question : req.body?.question;

            if (!question) {
                res.status(400).json({
                    error: "질문이 필요합니다.",
                    usage: 'GET: ?question=질문내용 또는 POST: {"question": "질문내용"}',
                });
                return;
            }

            const response = await processUserQuery(
                question,
                openaiApiKey.value()
            );

            res.json({
                question: question,
                answer: response,
            });
        } catch (error) {
            console.error("Error details:", error);
            res.status(500).json({
                error: "서버 오류가 발생했습니다.",
                message: error.message,
            });
        }
    }
);

// —————— 10) 카카오톡 챗봇 스킬 엔드포인트 ——————
export const kakaoSkill = onRequest(
    {
        invoker: "public",
        cors: true,
        secrets: [openaiApiKey],
    },
    async (req, res) => {
        try {
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Access-Control-Allow-Methods", "POST");
            res.set("Access-Control-Allow-Headers", "Content-Type");

            if (req.method === "OPTIONS") {
                res.status(204).send("");
                return;
            }

            const { userRequest } = req.body;

            if (!userRequest || !userRequest.utterance) {
                return res.status(400).json({
                    version: "2.0",
                    template: {
                        outputs: [
                            {
                                simpleText: {
                                    text: "질문을 입력해주세요.",
                                },
                            },
                        ],
                    },
                });
            }

            const question = userRequest.utterance;
            const answer = await processUserQuery(
                question,
                openaiApiKey.value()
            );

            res.json({
                version: "2.0",
                template: {
                    outputs: [
                        {
                            simpleText: {
                                text: answer,
                            },
                        },
                    ],
                },
            });
        } catch (error) {
            console.error("카카오톡 스킬 오류:", error);
            res.json({
                version: "2.0",
                template: {
                    outputs: [
                        {
                            simpleText: {
                                text: "죄송합니다. 서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
                            },
                        },
                    ],
                },
            });
        }
    }
);

// Firebase Functions v2 전용 - CLI 테스트 코드 제거
// 로컬 테스트는 Firebase Emulator를 사용하세요: firebase emulators:start --only functions
