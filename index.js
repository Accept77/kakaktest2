// index.js
require("dotenv").config();
const { google } = require("googleapis");
const { OpenAI } = require("openai");
const stringSimilarity = require("string-similarity");

// —————— 1) 환경 변수 & 상수 ——————
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const CRED_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const MAIN_TAB = "Sheet1"; // 기본 시트명으로 변경
const TELECOMS = ["SK", "KT", "LG"];
const CHANNELS = ["온라인", "내방"];
const TYPES = ["번호이동", "기기변경"];

// —————— 2) 클라이언트 초기화 ——————
const auth = new google.auth.GoogleAuth({
    keyFile: CRED_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// —————— 2.1) 시트 목록 확인 함수 ——————
async function listSheetNames() {
    try {
        const response = await sheets.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID,
        });

        const sheetNames = response.data.sheets.map(
            (sheet) => sheet.properties.title
        );

        return sheetNames;
    } catch (error) {
        console.error("시트 목록을 가져오는 데 실패했습니다:", error.message);
        return [];
    }
}

// —————— 3) 시트 구조 확인 함수 ——————
async function checkSheetStructure() {
    // 먼저 시트 목록 확인
    const sheetNames = await listSheetNames();
    if (sheetNames.length === 0) {
        throw new Error("시트 목록을 가져올 수 없습니다.");
    }

    // 첫 번째 시트만 확인
    const firstSheet = sheetNames[0];

    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${firstSheet}!A1:Z5`, // 처음 5행만 확인
    });
    const rows = res.data.values || [];

    return { sheetNames, headerRows: rows };
}

// —————— 3) 스프레드시트 전체 구조 파싱 ——————
async function parseFullSheetStructure() {
    // 먼저 시트 목록 확인
    const sheetNames = await listSheetNames();
    if (sheetNames.length === 0) {
        throw new Error("시트 목록을 가져올 수 없습니다.");
    }

    const allRecords = [];

    // 모든 시트 처리
    for (const sheetName of sheetNames) {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${sheetName}!A1:Z100`,
        });
        const rows = res.data.values || [];

        if (rows.length < 3) {
            continue;
        }

        // 시트별 정보 추출
        const sheetInfo = parseSheetInfo(sheetName);

        // 데이터 파싱 (3행부터) - 새로운 구조 적용
        for (let i = 2; i < rows.length; i++) {
            const row = rows[i];
            if (!row[0] || row[0].trim() === "") continue;

            // 부가서비스 정보 파싱 (K, L, M, N 열)
            const serviceInfo = parseServiceInfoNew(row);

            // 번호이동 정보 (A, B, C, D열)
            if (row[0] && row[1] && row[2] && row[3]) {
                const modelName = row[0].trim();
                const modelNorm = normalizeModelName(modelName);
                const capacity = row[2].trim(); // 용량은 이제 별도 컬럼에서 직접 가져옴

                allRecords.push({
                    modelRaw: modelName,
                    modelNorm: modelNorm,
                    capacity: capacity,
                    telecom: sheetInfo.telecom,
                    type: "번호이동",
                    channel: sheetInfo.channel,
                    plan: cleanPrice(row[1]),
                    price: cleanPrice(row[3]),
                    serviceInfo: serviceInfo,
                });
            }

            // 기기변경 정보 (F, G, H, I열)
            if (row[5] && row[6] && row[7] && row[8]) {
                const modelName = row[5].trim();
                const modelNorm = normalizeModelName(modelName);
                const capacity = row[7].trim(); // 용량은 이제 별도 컬럼에서 직접 가져옴

                allRecords.push({
                    modelRaw: modelName,
                    modelNorm: modelNorm,
                    capacity: capacity,
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

    // 각 통신사별 공통 부가서비스 정보 추출 (복수 부가서비스 지원)
    const commonServiceInfo = {};
    allRecords.forEach((record) => {
        if (record.serviceInfo && record.serviceInfo.serviceName) {
            const key = `${record.telecom}-${record.channel}`;
            if (!commonServiceInfo[key]) {
                commonServiceInfo[key] = [];
            }

            // 중복 제거: 같은 서비스명이 이미 있는지 확인
            const existingService = commonServiceInfo[key].find(
                (service) =>
                    service.serviceName === record.serviceInfo.serviceName
            );

            if (!existingService) {
                commonServiceInfo[key].push(record.serviceInfo);
            }
        }
    });

    // 통신사별 공통 부가서비스 정보 추출 완료

    return { allRecords, commonServiceInfo };
}

// —————— 3.1) 시트 정보 파싱 ——————
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

// —————— 4) 유틸리티 함수들 (업데이트) ——————
function normalizeModelName(modelName) {
    return modelName
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/[^a-z0-9ㄱ-ㅎ가-힣]/g, "");
}

function cleanPrice(priceStr) {
    if (!priceStr) return "";
    return priceStr.toString().replace(/[^\d-]/g, "");
}

function parseServiceInfoNew(row) {
    // 부가서비스 정보는 K, L, M, N 열에 있음 (인덱스 10, 11, 12, 13)
    if (row[10] && row[11] && row[12] && row[13]) {
        return {
            serviceName: row[10].trim(),
            monthlyFee: cleanPrice(row[11]),
            duration: row[12].trim(),
            additionalFee: cleanPrice(row[13]),
        };
    }
    return null;
}

// —————— 5) 질문 분석 및 시나리오 분류 ——————
function analyzeQuestion(question) {
    const q = question.toLowerCase().trim();

    // 시나리오 분류
    const scenarios = {
        COMPARISON: /(\w+)랑|어디가|뭐가|더|비교|vs|대|차이/.test(q),
        MODEL_ONLY: checkModelOnly(q),
        MODEL_CAPACITY: checkModelCapacity(q),
        MODEL_CAPACITY_TELECOM: checkModelCapacityTelecom(q),
        FULL_CONDITION: checkFullCondition(q),
        INFORMAL: checkInformal(q),
    };

    // 모델명, 용량, 통신사, 타입 추출
    const extracted = extractFromQuestion(q);

    return {
        originalQuestion: question,
        scenarios: scenarios,
        extracted: extracted,
        primaryScenario: getPrimaryScenario(scenarios),
    };
}

function checkModelOnly(q) {
    const modelMatch = /(갤럭시|아이폰)/i.exec(q);
    const allNumbers = q.match(/\b\d+\b/g);
    let hasValidCapacity = false;

    if (allNumbers) {
        const numbers = allNumbers.map((n) => parseInt(n));
        const validCapacities = numbers.filter((n) => n >= 64);
        hasValidCapacity = validCapacities.length > 0;
    }

    return modelMatch && !hasValidCapacity;
}

function checkModelCapacity(q) {
    const modelMatch = /(갤럭시|아이폰)/i.exec(q);
    const allNumbers = q.match(/\b\d+\b/g);
    let hasValidCapacity = false;

    if (allNumbers) {
        const numbers = allNumbers.map((n) => parseInt(n));
        const validCapacities = numbers.filter((n) => n >= 64);
        hasValidCapacity = validCapacities.length > 0;
    }

    const telecomMatch = /(SK|KT|LG)/i.exec(q);
    const typeMatch = /(번호이동|기기변경|기변|번이)/i.exec(q);
    return modelMatch && hasValidCapacity && !telecomMatch && !typeMatch;
}

function checkModelCapacityTelecom(q) {
    const modelMatch = /(갤럭시|아이폰)/i.exec(q);
    const capacityMatch = /(\d+)(?:GB)?/i.exec(q);
    const telecomMatch = /(SK|KT|LG)/i.exec(q);
    const typeMatch = /(번호이동|기기변경|기변|번이)/i.exec(q);
    return modelMatch && capacityMatch && telecomMatch && !typeMatch;
}

function checkFullCondition(q) {
    const modelMatch = /(갤럭시|아이폰)/i.exec(q);
    const capacityMatch = /(\d+)(?:GB)?/i.exec(q);
    const telecomMatch = /(SK|KT|LG)/i.exec(q);
    const typeMatch = /(번호이동|기기변경|기변|번이)/i.exec(q);
    return modelMatch && capacityMatch && telecomMatch && typeMatch;
}

function checkInformal(q) {
    // 축약어, 오타 등 감지
    return (
        /프맥|울트라|플러스|프로/.test(q) ||
        /sk|kt|lg/.test(q) ||
        /번이|기변/.test(q) ||
        /\d+프|프\d+/.test(q) || // 16프, 프16 등
        /가격\s*좀|좀\s*가격/.test(q) || // 가격좀, 좀 가격
        /\w+\d+\w+/.test(q) // 연속된 문자+숫자+문자 패턴
    );
}

function extractFromQuestion(q) {
    // 더 정밀한 정규식 패턴 사용
    const modelMatch = /(갤럭시|아이폰)\s*(\S*?)\s*/i.exec(q);
    const capacityMatch = /\b(\d+)(?:GB)?\b/gi.exec(q); // 단어 경계 사용
    const telecomMatch = /(SK|SKT|KT|LG)/i.exec(q);
    const typeMatch = /(번호이동|기기변경|기변|번이)/i.exec(q);

    let brand = null,
        model = null,
        capacity = null;

    if (modelMatch) {
        brand = modelMatch[1];
        model = modelMatch[2] || "";
    }

    // 용량 추출: 모든 숫자를 찾아서 가장 큰 것을 용량으로 간주
    const allNumbers = q.match(/\b\d+\b/g);
    if (allNumbers) {
        const numbers = allNumbers.map((n) => parseInt(n));
        // 64 이상의 숫자 중 가장 큰 것을 용량으로 간주
        const validCapacities = numbers.filter((n) => n >= 64);
        if (validCapacities.length > 0) {
            capacity = Math.max(...validCapacities).toString();
        } else {
            // 64 미만이면 가장 큰 숫자 사용
            capacity = Math.max(...numbers).toString();
        }
    }

    return {
        brand: brand,
        model: model,
        capacity: capacity,
        telecom: telecomMatch
            ? telecomMatch[1].replace("SKT", "SK").toUpperCase()
            : null,
        type: typeMatch ? normalizeType(typeMatch[1]) : null,
    };
}

function normalizeType(type) {
    if (type === "기변") return "기기변경";
    if (type === "번이") return "번호이동";
    return type;
}

function getPrimaryScenario(scenarios) {
    if (scenarios.COMPARISON) return "COMPARISON";
    if (scenarios.INFORMAL) return "INFORMAL"; // INFORMAL을 우선순위 높임
    if (scenarios.FULL_CONDITION) return "FULL_CONDITION";
    if (scenarios.MODEL_CAPACITY_TELECOM) return "MODEL_CAPACITY_TELECOM";
    if (scenarios.MODEL_CAPACITY) return "MODEL_CAPACITY";
    if (scenarios.MODEL_ONLY) return "MODEL_ONLY";
    return "UNKNOWN";
}

// —————— 6) 시나리오별 응답 생성 ——————
async function generateResponse(analysis, records, commonServiceInfo) {
    const { primaryScenario, extracted, originalQuestion } = analysis;

    switch (primaryScenario) {
        case "MODEL_ONLY":
            return handleModelOnly(extracted, records);
        case "MODEL_CAPACITY":
            return handleModelCapacity(extracted, records, commonServiceInfo);
        case "MODEL_CAPACITY_TELECOM":
            return handleModelCapacityTelecom(
                extracted,
                records,
                commonServiceInfo
            );
        case "FULL_CONDITION":
            return handleFullCondition(extracted, records, commonServiceInfo);
        case "COMPARISON":
            return handleComparisonWithGPT(originalQuestion, records);
        case "INFORMAL":
            return handleInformalWithGPT(
                originalQuestion,
                records,
                commonServiceInfo
            );
        default:
            return "죄송합니다. 질문을 이해하지 못했습니다. 다시 말씀해주세요.";
    }
}

function handleModelOnly(extracted, records) {
    const { brand, model } = extracted;
    const modelPrefix = brand + (model || "");

    // 해당 브랜드의 모든 모델 찾기
    const matchingModels = records.filter((r) =>
        r.modelNorm.includes(modelPrefix.toLowerCase())
    );

    if (matchingModels.length === 0) {
        return `${brand} 관련 정보를 찾을 수 없습니다.`;
    }

    // 고유 모델명 목록 생성
    const uniqueModels = [...new Set(matchingModels.map((r) => r.modelRaw))];

    return `${brand} 종류가 많아서 정확한 답변이 어렵습니다.
아래 ${brand} 관련 모델명을 알려드릴테니,
정확한 모델명과 용량을 말씀해주세요.
(예: ${brand} 16 PRO 128)

${uniqueModels.slice(0, 10).join("\n")}

더 정확한 가격 안내를 위해 "모델명 + 용량"을 함께 말씀해주세요.`;
}

function handleModelCapacity(extracted, records, commonServiceInfo) {
    const { brand, model, capacity } = extracted;

    // 브랜드 + 모델 조합으로 검색 (GPT 결과 개선)
    const fullModelQuery = (brand + " " + (model || ""))
        .toLowerCase()
        .replace(/\s+/g, "");

    // 모델명 매칭 - 전체 모델명으로 비교
    const availableModels = [...new Set(records.map((r) => r.modelNorm))];
    const { bestMatch } = stringSimilarity.findBestMatch(
        fullModelQuery,
        availableModels
    );

    const matchingRecords = records.filter(
        (r) => r.modelNorm === bestMatch.target && r.capacity === capacity
    );

    if (matchingRecords.length === 0) {
        return `${brand} ${model} ${capacity}GB 정보를 찾을 수 없습니다.
        
🔍 검색된 모델: ${bestMatch.target}
📋 사용 가능한 모델들:
${availableModels
    .filter((m) => m.includes(brand.toLowerCase()))
    .slice(0, 5)
    .join("\n")}`;
    }

    // 전체 조건 (6가지) 안내
    return formatAllConditions(
        matchingRecords,
        `${brand} ${model} ${capacity}GB`,
        commonServiceInfo
    );
}

function handleModelCapacityTelecom(extracted, records, commonServiceInfo) {
    const { brand, model, capacity, telecom } = extracted;
    const modelQuery = (brand + (model || ""))
        .toLowerCase()
        .replace(/\s+/g, "");

    const availableModels = [...new Set(records.map((r) => r.modelNorm))];
    const { bestMatch } = stringSimilarity.findBestMatch(
        modelQuery,
        availableModels
    );

    const matchingRecords = records.filter(
        (r) =>
            r.modelNorm === bestMatch.target &&
            r.capacity === capacity &&
            r.telecom === telecom
    );

    if (matchingRecords.length === 0) {
        return `${brand} ${model} ${capacity}GB ${telecom} 정보를 찾을 수 없습니다.`;
    }

    return formatTelecomConditions(
        matchingRecords,
        `${brand} ${model} ${capacity}GB ${telecom}`,
        commonServiceInfo
    );
}

function handleFullCondition(extracted, records, commonServiceInfo) {
    const { brand, model, capacity, telecom, type } = extracted;
    const modelQuery = (brand + (model || ""))
        .toLowerCase()
        .replace(/\s+/g, "");

    const availableModels = [...new Set(records.map((r) => r.modelNorm))];
    const { bestMatch } = stringSimilarity.findBestMatch(
        modelQuery,
        availableModels
    );

    const matchingRecords = records.filter(
        (r) =>
            r.modelNorm === bestMatch.target &&
            r.capacity === capacity &&
            r.telecom === telecom &&
            r.type === type
    );

    if (matchingRecords.length === 0) {
        return `${brand} ${model} ${capacity}GB ${telecom} ${type} 정보를 찾을 수 없습니다.`;
    }

    return formatSpecificCondition(
        matchingRecords,
        `${brand} ${model} ${capacity}GB ${telecom} ${type}`,
        commonServiceInfo
    );
}

function handleComparison(question) {
    return `말씀해주신 질문은 가격 비교가 필요한 상황으로 보여요 😊  
정확한 비교를 위해 아래 정보를 함께 알려주시면 도와드릴게요:
📌 모델명 + 용량  
📌 통신사 (SK/KT/LG)  
📌 번호이동 or 기기변경  
📌 온라인 or 내방 희망 여부

예시: "아이폰 15 256 LG 번호이동은 얼마예요?"`;
}

async function handleInformalWithGPT(question, records, commonServiceInfo) {
    const gptResult = await processWithGPT(question, "INFORMAL");

    if (!gptResult) {
        return handleInformal(question, {
            brand: null,
            model: null,
            capacity: null,
            telecom: null,
            type: null,
        });
    }

    // GPT 결과를 시스템 형식으로 변환
    const normalizedExtracted = {
        brand: gptResult.브랜드 || gptResult.brand,
        model: gptResult.모델 || gptResult.model,
        capacity: String(gptResult.용량 || gptResult.capacity), // 문자열로 변환
        telecom: gptResult.통신사 || gptResult.telecom,
        type: gptResult.타입 || gptResult.type,
    };

    // 정규화된 결과로 다시 시나리오 분류
    const hasModel = normalizedExtracted.brand;
    const hasCapacity = normalizedExtracted.capacity;
    const hasTelecom = normalizedExtracted.telecom;
    const hasType = normalizedExtracted.type;

    if (hasModel && hasCapacity && hasTelecom && hasType) {
        return handleFullCondition(
            normalizedExtracted,
            records,
            commonServiceInfo
        );
    } else if (hasModel && hasCapacity && hasTelecom) {
        return handleModelCapacityTelecom(
            normalizedExtracted,
            records,
            commonServiceInfo
        );
    } else if (hasModel && hasCapacity) {
        return handleModelCapacity(
            normalizedExtracted,
            records,
            commonServiceInfo
        );
    } else if (hasModel) {
        return handleModelOnly(normalizedExtracted, records);
    } else {
        return `GPT 분석 결과: ${JSON.stringify(normalizedExtracted, null, 2)}
        
정확한 가격 안내를 위해 아래처럼 말씀해주시면 더 빠르게 안내드릴 수 있어요:
예: 갤럭시 S25 256 SK 번호이동 얼마예요?
또는: 아이폰 16 PRO Max 512 얼마에요?`;
    }
}

async function handleComparisonWithGPT(question, records) {
    const gptResult = await processWithGPT(question, "COMPARISON");

    if (!gptResult) {
        return handleComparison(question);
    }

    // 추출된 정보로 부분적 결과 제공 시도
    const extractedInfo = {
        brand: gptResult.추출된_브랜드 || gptResult.brand,
        model: gptResult.추출된_모델 || gptResult.model,
        capacity: gptResult.추출된_용량 || gptResult.capacity,
        telecom: gptResult.추출된_통신사 || gptResult.telecom,
        type: null,
    };

    const missingInfo = gptResult.누락된_정보 || gptResult.missing_info || [];
    const comparisonTarget = gptResult.비교대상 || gptResult.comparison_target;

    let response = `💭 GPT 분석: ${comparisonTarget}에 대한 비교를 원하시는군요!\n\n`;

    if (extractedInfo.brand || extractedInfo.model) {
        response += `🔍 현재 파악된 정보:\n`;
        if (extractedInfo.brand)
            response += `- 브랜드: ${extractedInfo.brand}\n`;
        if (extractedInfo.model) response += `- 모델: ${extractedInfo.model}\n`;
        if (extractedInfo.capacity)
            response += `- 용량: ${extractedInfo.capacity}GB\n`;
        if (extractedInfo.telecom)
            response += `- 통신사: ${extractedInfo.telecom}\n`;
        response += `\n`;
    }

    if (missingInfo.length > 0) {
        response += `📋 정확한 비교를 위해 추가로 필요한 정보:\n`;
        missingInfo.forEach((info) => {
            response += `- ${info}\n`;
        });
        response += `\n`;
    }

    response += `💡 예시: "${extractedInfo.brand || "갤럭시"} ${
        extractedInfo.model || "S25"
    } ${extractedInfo.capacity || "256"} SK와 KT 중 어디가 더 저렴한가요?"`;

    return response;
}

// —————— 6.5) GPT 자연어 처리 함수 ——————
async function processWithGPT(userInput, scenario) {
    try {
        let prompt = "";

        if (scenario === "INFORMAL") {
            prompt = `
다음 사용자 입력을 분석하여 정확한 휴대폰 정보를 추출해주세요:

사용자 입력: "${userInput}"

다음 형식으로 답변해주세요:
- 브랜드: (갤럭시 또는 아이폰)
- 모델: (정확한 모델명, 예: S25, 16, 16 PRO Max)
- 용량: (숫자만, 예: 256, 512. 명시되지 않았다면 일반적인 용량인 256을 제안)
- 통신사: (SK, KT, LG 중 하나, 없으면 null)
- 타입: (번호이동 또는 기기변경, 없으면 null)

축약어 변환 예시:
- "프맥" → "PRO Max"
- "울트라" → "울트라" 
- "플러스" → "PLUS"
- "16프" → "16 PRO"
- "기변" → "기기변경"
- "번이" → "번호이동"

중요: 용량이 명시되지 않은 경우 256을 기본값으로 제안해주세요.

JSON 형식으로만 답변해주세요.
`;
        } else if (scenario === "COMPARISON") {
            prompt = `
다음 사용자 입력을 분석하여 비교 요청의 의도를 파악해주세요:

사용자 입력: "${userInput}"

사용자가 비교하고자 하는 것이 무엇인지 분석하고, 정확한 비교를 위해 필요한 정보를 추출해주세요.

다음 형식으로 답변해주세요:
- 비교대상: (통신사, 모델, 요금제 등)
- 추출된_브랜드: (갤럭시 또는 아이폰, 없으면 null)
- 추출된_모델: (모델명, 없으면 null)
- 추출된_용량: (숫자만, 없으면 null)
- 추출된_통신사: (SK, KT, LG 중 하나, 없으면 null)
- 누락된_정보: (비교를 위해 추가로 필요한 정보 리스트)

JSON 형식으로만 답변해주세요.
`;
        }

        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    role: "system",
                    content:
                        "당신은 휴대폰 가격 비교 시스템의 자연어 처리 전문가입니다. 사용자의 입력을 정확히 분석하고 JSON 형식으로만 답변해주세요.",
                },
                {
                    role: "user",
                    content: prompt,
                },
            ],
            temperature: 0.1,
            max_tokens: 500,
        });

        const gptResponse = response.choices[0].message.content.trim();

        // JSON 파싱 시도
        try {
            const parsed = JSON.parse(gptResponse);
            return parsed;
        } catch (e) {
            return null;
        }
    } catch (error) {
        console.error("▶ GPT 처리 중 오류:", error.message);
        return null;
    }
}

// —————— 7) 포맷팅 함수들 ——————
function formatAllConditions(records, modelInfo, commonServiceInfo) {
    const grouped = groupByTelecomAndChannelAndType(records);

    let result = `📱 ${modelInfo} 전체 가격 조건을 안내드려요:\n\n`;

    for (const telecom of TELECOMS) {
        if (grouped[telecom]) {
            result += `═══════════════════════════════════════════════════════════════════════════════\n`;

            // 온라인 가격 조건
            if (grouped[telecom]["온라인"]) {
                result += `📦 온라인 가격 조건 안내 (${telecom})\n\n`;

                for (const type of TYPES) {
                    if (grouped[telecom]["온라인"][type]) {
                        // 첫 번째 레코드 사용 (가격 정보는 동일하므로)
                        const record = grouped[telecom]["온라인"][type][0];
                        result += formatDetailedCondition(
                            record,
                            telecom,
                            type,
                            commonServiceInfo
                        );
                    }
                }
            }

            // 내방 가격 조건
            if (grouped[telecom]["내방"]) {
                result += `🏬 내방 가격 조건 안내 (${telecom})\n\n`;

                for (const type of TYPES) {
                    if (grouped[telecom]["내방"][type]) {
                        // 첫 번째 레코드 사용 (가격 정보는 동일하므로)
                        const record = grouped[telecom]["내방"][type][0];
                        result += formatDetailedCondition(
                            record,
                            telecom,
                            type,
                            commonServiceInfo
                        );
                    }
                }
            }

            result += `\n`;
        }
    }

    return result;
}

function formatDetailedCondition(record, telecom, type, commonServiceInfo) {
    let result = `📱 ${telecom} ${type}\n`;
    result += `✅ 할부원금: ${formatPrice(record.price)}원\n`;
    result += `✅ 요금제: 월 ${formatPrice(record.plan)}원\n`;

    // 공통 부가서비스 정보 사용 (배열로 저장된 복수 부가서비스)
    const serviceKey = `${telecom}-${record.channel}`;
    const serviceInfoArray = commonServiceInfo[serviceKey];

    if (serviceInfoArray && serviceInfoArray.length > 0) {
        result += `✅ 부가서비스\n`;

        // 모든 부가서비스 표시
        serviceInfoArray.forEach((serviceInfo, index) => {
            if (serviceInfo.duration) {
                result += ` - ${serviceInfo.serviceName} (${serviceInfo.duration} 유지)`;
            } else {
                result += ` - ${serviceInfo.serviceName}`;
            }

            if (
                serviceInfo.monthlyFee &&
                serviceInfo.monthlyFee !== "" &&
                serviceInfo.monthlyFee !== "0"
            ) {
                result += `: 월 ${formatPrice(serviceInfo.monthlyFee)}원`;
            }
            result += `\n`;
        });

        // 미가입시 추가금 표시
        result += `❗ 부가 미가입 시\n`;
        serviceInfoArray.forEach((serviceInfo) => {
            if (
                serviceInfo.additionalFee &&
                serviceInfo.additionalFee !== "0"
            ) {
                result += ` - ${serviceInfo.serviceName} 미가입: +${formatPrice(
                    serviceInfo.additionalFee
                )}원\n`;
            }
        });
    }

    result += `\n`;
    return result;
}

function formatPrice(price) {
    if (!price || price === "0" || price === "") return "0";
    return parseInt(price).toLocaleString();
}

function formatTelecomConditions(records, modelInfo, commonServiceInfo) {
    const grouped = groupByChannelAndType(records);

    let result = `📱 ${modelInfo} 조건을 안내드려요:\n\n`;
    result += `═══════════════════════════════════════════════════════════════════════════════\n`;

    // 온라인 조건
    if (grouped["온라인"]) {
        result += `📦 온라인 가격 조건 안내 (${records[0].telecom})\n\n`;

        for (const type of TYPES) {
            if (grouped["온라인"][type]) {
                // 첫 번째 레코드 사용 (가격 정보는 동일하므로)
                const record = grouped["온라인"][type][0];
                result += formatDetailedCondition(
                    record,
                    record.telecom,
                    type,
                    commonServiceInfo
                );
            }
        }
    }

    // 내방 조건
    if (grouped["내방"]) {
        result += `🏬 내방 가격 조건 안내 (${records[0].telecom})\n\n`;

        for (const type of TYPES) {
            if (grouped["내방"][type]) {
                // 첫 번째 레코드 사용 (가격 정보는 동일하므로)
                const record = grouped["내방"][type][0];
                result += formatDetailedCondition(
                    record,
                    record.telecom,
                    type,
                    commonServiceInfo
                );
            }
        }
    }

    return result;
}

function formatSpecificCondition(allRecords, modelInfo, commonServiceInfo) {
    // allRecords 배열에서 첫 번째 레코드의 정보를 기준으로 관련 레코드들을 찾음
    const firstRecord = allRecords[0];
    const telecom = firstRecord.telecom;
    const type = firstRecord.type;

    let result = `📱 ${modelInfo} 조건을 안내드려요:\n\n`;
    result += `═══════════════════════════════════════════════════════════════════════════════\n`;

    // 온라인 조건 찾기
    const onlineRecord = allRecords.find(
        (r) =>
            r.telecom === telecom && r.type === type && r.channel === "온라인"
    );
    if (onlineRecord) {
        result += `📦 온라인 가격 조건\n\n`;
        result += formatDetailedCondition(
            onlineRecord,
            telecom,
            type,
            commonServiceInfo
        );
    }

    // 내방 조건 찾기
    const offlineRecord = allRecords.find(
        (r) => r.telecom === telecom && r.type === type && r.channel === "내방"
    );
    if (offlineRecord) {
        result += `🏬 내방 가격 조건\n\n`;
        result += formatDetailedCondition(
            offlineRecord,
            telecom,
            type,
            commonServiceInfo
        );
    }

    return result;
}

function groupByTelecomAndChannelAndType(records) {
    const grouped = {};

    for (const record of records) {
        if (!grouped[record.telecom]) {
            grouped[record.telecom] = {};
        }
        if (!grouped[record.telecom][record.channel]) {
            grouped[record.telecom][record.channel] = {};
        }
        if (!grouped[record.telecom][record.channel][record.type]) {
            grouped[record.telecom][record.channel][record.type] = [];
        }
        grouped[record.telecom][record.channel][record.type].push(record);
    }

    return grouped;
}

function groupByChannelAndType(records) {
    const grouped = {};

    for (const record of records) {
        if (!grouped[record.channel]) {
            grouped[record.channel] = {};
        }
        if (!grouped[record.channel][record.type]) {
            grouped[record.channel][record.type] = [];
        }
        grouped[record.channel][record.type].push(record);
    }

    return grouped;
}

function groupByTelecomAndType(records) {
    const grouped = {};

    for (const record of records) {
        if (!grouped[record.telecom]) {
            grouped[record.telecom] = {};
        }
        if (!grouped[record.telecom][record.type]) {
            grouped[record.telecom][record.type] = [];
        }
        grouped[record.telecom][record.type].push(record);
    }

    return grouped;
}

function groupByType(records) {
    const grouped = {};

    for (const record of records) {
        if (!grouped[record.type]) {
            grouped[record.type] = [];
        }
        grouped[record.type].push(record);
    }

    return grouped;
}

function handleInformal(question, extracted) {
    let suggestion =
        "정확한 가격 안내를 위해 아래처럼 말씀해주시면 더 빠르게 안내드릴 수 있어요:\n";

    if (extracted.brand) {
        suggestion += `예: ${extracted.brand} 16 프로 256 SK 번호이동 얼마예요?\n`;
        suggestion += `또는: ${extracted.brand} 16 프로 256 얼마에요?`;
    } else {
        suggestion += "예: 아이폰 16 프로 256 SK 번호이동 얼마예요?\n";
        suggestion += "또는: 갤럭시 S25 256 얼마에요?";
    }

    return suggestion;
}

function handleComparison(question) {
    return `말씀해주신 질문은 가격 비교가 필요한 상황으로 보여요 😊  
정확한 비교를 위해 아래 정보를 함께 알려주시면 도와드릴게요:
📌 모델명 + 용량  
📌 통신사 (SK/KT/LG)  
📌 번호이동 or 기기변경  
📌 온라인 or 내방 희망 여부

예시: "아이폰 15 256 LG 번호이동은 얼마예요?"`;
}

// —————— 8) 메인 함수 ——————
(async () => {
    try {
        const question = process.argv.slice(2).join(" ");

        // 구조 확인만 수행
        if (question === "구조확인" || question === "check") {
            await checkSheetStructure();
            return;
        }

        if (!question) {
            console.error(
                '⛔ 사용법: node index.js "갤럭시 S25 256 SK 번호이동 얼마예요?"'
            );
            console.error('⛔ 구조 확인: node index.js "구조확인"');
            process.exit(1);
        }

        const { allRecords, commonServiceInfo } =
            await parseFullSheetStructure();

        const analysis = analyzeQuestion(question);
        const response = await generateResponse(
            analysis,
            allRecords,
            commonServiceInfo
        );

        console.log(response);
    } catch (err) {
        console.error("\n[ERROR]", err.message);
        process.exit(1);
    }
})();
