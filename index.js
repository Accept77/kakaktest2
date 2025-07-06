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
// Firebase Functions v2 환경변수 정의
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
// Firebase Functions에서는 기본 인증 사용 (서비스 계정)
const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

// OpenAI 클라이언트는 함수 내에서 초기화 (환경변수 접근 때문)

// —————— 2.1) 시트 목록 확인 함수 ——————
async function listSheetNames(spreadsheetId) {
    try {
        const response = await sheets.spreadsheets.get({
            spreadsheetId: spreadsheetId,
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
async function checkSheetStructure(spreadsheetId) {
    // 먼저 시트 목록 확인
    const sheetNames = await listSheetNames(spreadsheetId);
    if (sheetNames.length === 0) {
        throw new Error("시트 목록을 가져올 수 없습니다.");
    }

    // 첫 번째 시트만 확인
    const firstSheet = sheetNames[0];

    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: `${firstSheet}!A1:Z5`, // 처음 5행만 확인
    });
    const rows = res.data.values || [];

    return { sheetNames, headerRows: rows };
}

// —————— 3) 스프레드시트 전체 구조 파싱 ——————
async function parseFullSheetStructure(spreadsheetId) {
    // 먼저 시트 목록 확인
    const sheetNames = await listSheetNames(spreadsheetId);
    if (sheetNames.length === 0) {
        throw new Error("시트 목록을 가져올 수 없습니다.");
    }

    const allRecords = [];

    // 모든 시트 처리
    for (const sheetName of sheetNames) {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
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
            if (row[0] && row[1] && row[3]) {
                // row[2] 조건 제거 (용량이 없을 수 있음)
                const modelName = row[0].trim();
                const modelNorm = normalizeModelName(modelName);
                const capacity = normalizeCapacity(row[2]); // 용량 정규화 적용

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
            if (row[5] && row[6] && row[8]) {
                // row[7] 조건 제거 (용량이 없을 수 있음)
                const modelName = row[5].trim();
                const modelNorm = normalizeModelName(modelName);
                const capacity = normalizeCapacity(row[7]); // 용량 정규화 적용

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

// 용량 정규화 함수 추가
function normalizeCapacity(capacity) {
    if (!capacity || capacity.trim() === "") {
        return "기본"; // 용량이 없는 경우 기본값
    }

    // 숫자만 추출
    const numbers = capacity.match(/\d+/g);
    if (numbers && numbers.length > 0) {
        return numbers[0]; // 첫 번째 숫자만 사용
    }

    return "기본"; // 숫자를 찾을 수 없는 경우
}

// 용량 매칭 함수 (개선된 버전)
function isCapacityMatch(userCapacity, recordCapacity) {
    // 둘 다 null이거나 빈 문자열인 경우
    if (
        (!userCapacity || userCapacity === "") &&
        (!recordCapacity || recordCapacity === "")
    ) {
        return true;
    }

    // 사용자가 용량을 지정하지 않은 경우, 모든 레코드 매칭
    if (!userCapacity || userCapacity === "") {
        return true;
    }

    // 레코드에 용량이 없는 경우 ("기본" 또는 빈 값)
    if (!recordCapacity || recordCapacity === "기본" || recordCapacity === "") {
        // 사용자가 용량을 지정했다면 매칭하지 않음
        return false;
    }

    // 정확히 일치하는 경우
    if (userCapacity === recordCapacity) {
        return true;
    }

    // 숫자로 비교 (용량 단위 무시)
    const userNum = userCapacity ? userCapacity.toString().match(/\d+/g) : null;
    const recordNum = recordCapacity
        ? recordCapacity.toString().match(/\d+/g)
        : null;

    if (userNum && recordNum) {
        return userNum[0] === recordNum[0];
    }

    return false;
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
        COMPARISON:
            /(\w+)랑|어디가|뭐가|더|비교|vs|대|차이|싼가요|저렴한가요|이득|낫|좋|나은/.test(
                q
            ),
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
    const modelMatch = /(갤럭시|아이폰|galaxy|iphone)/i.exec(q);
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
    const modelMatch = /(갤럭시|아이폰|galaxy|iphone)/i.exec(q);
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
    const modelMatch = /(갤럭시|아이폰|galaxy|iphone)/i.exec(q);
    const capacityMatch = /(\d+)(?:GB)?/i.exec(q);
    const telecomMatch = /(SK|KT|LG)/i.exec(q);
    const typeMatch = /(번호이동|기기변경|기변|번이)/i.exec(q);
    return modelMatch && capacityMatch && telecomMatch && !typeMatch;
}

function checkFullCondition(q) {
    const modelMatch = /(갤럭시|아이폰|galaxy|iphone)/i.exec(q);
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
        (/\w+\d+\w+/.test(q) &&
            !/^(갤럭시|아이폰|galaxy|iphone)\s+\w*\d+\w*$/i.test(q)) // 연속된 문자+숫자+문자 패턴 (단, 정상적인 모델명 제외)
    );
}

function extractFromQuestion(q) {
    // 더 정밀한 정규식 패턴 사용 - 갤럭시 + 인식 개선
    const modelMatch =
        /(갤럭시|아이폰|galaxy|iphone)\s*([^0-9]*?)(?=\s*\d|\s*$)/i.exec(q);
    const capacityMatch = /\b(\d+)(?:GB)?\b/gi.exec(q); // 단어 경계 사용
    const telecomMatch = /(SK|SKT|KT|LG)/i.exec(q);
    const typeMatch = /(번호이동|기기변경|기변|번이)/i.exec(q);

    let brand = null,
        model = null,
        capacity = null;

    if (modelMatch) {
        brand = modelMatch[1];
        // 영어를 한글로 변환
        if (brand.toLowerCase() === "galaxy") brand = "갤럭시";
        if (brand.toLowerCase() === "iphone") brand = "아이폰";

        model = modelMatch[2] || "";

        // 모델명 정리: 양쪽 공백 제거 및 + 기호를 plus로 변환
        model = model.trim();
        if (model.includes("+")) {
            model = model.replace(/\s*\+\s*/g, " plus").trim();
        }
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
async function generateResponse(
    analysis,
    records,
    commonServiceInfo,
    openaiApiKey
) {
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
            return handleComparison(originalQuestion);
        case "INFORMAL":
            return handleInformalWithGPT(
                originalQuestion,
                records,
                commonServiceInfo,
                openaiApiKey
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

    // 해당 모델의 모든 레코드 확인
    const modelRecords = records.filter(
        (r) => r.modelNorm === bestMatch.target
    );

    const matchingRecords = records.filter(
        (r) =>
            r.modelNorm === bestMatch.target &&
            isCapacityMatch(capacity, r.capacity)
    );

    if (matchingRecords.length === 0) {
        // 사용 가능한 용량들도 표시 (용량 없는 모델 포함)
        const availableCapacities = [
            ...new Set(modelRecords.map((r) => r.capacity)),
        ].filter((cap) => cap !== ""); // 빈 값만 제거, "기본"은 포함

        // 가장 가까운 용량 찾기
        if (capacity && availableCapacities.length > 0) {
            const requestedCapacity = parseInt(capacity);
            const capacityNumbers = availableCapacities
                .map((cap) => parseInt(cap))
                .filter((num) => !isNaN(num))
                .sort(
                    (a, b) =>
                        Math.abs(a - requestedCapacity) -
                        Math.abs(b - requestedCapacity)
                );

            if (capacityNumbers.length > 0) {
                const closestCapacity = capacityNumbers[0].toString();

                // 가장 가까운 용량으로 다시 검색
                const fallbackRecords = records.filter(
                    (r) =>
                        r.modelNorm === bestMatch.target &&
                        r.capacity === closestCapacity
                );

                if (fallbackRecords.length > 0) {
                    return formatAllConditions(
                        fallbackRecords,
                        `${brand} ${model} ${closestCapacity}GB (${capacity}GB 대신 가장 가까운 용량)`,
                        commonServiceInfo
                    );
                }
            }
        }

        return `${brand} ${model} ${capacity}GB 정보를 찾을 수 없습니다.
        
🔍 검색된 모델: ${bestMatch.target}
📦 사용 가능한 용량: ${availableCapacities.join(", ")}

💡 사용 가능한 용량으로 다시 문의해주세요:
예: "${brand} ${model} ${availableCapacities[0]} 얼마예요?"`;
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
            isCapacityMatch(capacity, r.capacity) &&
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
            isCapacityMatch(capacity, r.capacity) &&
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

async function handleInformalWithGPT(
    question,
    records,
    commonServiceInfo,
    openaiApiKey
) {
    // 비교 키워드가 있으면 바로 비교 템플릿 반환
    const q = question.toLowerCase();
    if (
        /싼가요|저렴한가요|이득|낫|좋|나은|어디가|뭐가|더|비교|vs|대|차이/.test(
            q
        )
    ) {
        return handleComparison(question);
    }

    const gptResult = await processWithGPT(question, "INFORMAL", openaiApiKey);

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

    // 모델명이 undefined이거나 null인 경우 비교 템플릿 반환
    if (!normalizedExtracted.brand || normalizedExtracted.model === undefined) {
        return handleComparison(question);
    }

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

// —————— 6.5) GPT 자연어 처리 함수 ——————
async function processWithGPT(userInput, scenario, openaiApiKey) {
    try {
        const openai = new OpenAI({ apiKey: openaiApiKey });

        const prompt = `
다음 사용자 입력을 분석하여 정확한 휴대폰 정보를 추출해주세요:

사용자 입력: "${userInput}"

**중요한 변환 규칙:**
1. "+" 기호는 반드시 "PLUS"로 변환하세요
2. "galaxy s25 +" → 모델은 "S25 PLUS"가 되어야 합니다
3. "갤럭시 s25 +" → 모델은 "S25 PLUS"가 되어야 합니다

다음 형식으로 답변해주세요:
- 브랜드: (갤럭시 또는 아이폰)
- 모델: (정확한 모델명, 예: S25 PLUS, S25, 16 PRO Max)
- 용량: (숫자만, 예: 256, 512. 명시되지 않았다면 일반적인 용량인 256을 제안)
- 통신사: (SK, KT, LG 중 하나, 없으면 null)
- 타입: (번호이동 또는 기기변경, 없으면 null)

축약어 변환 예시:
- "프맥" → "PRO Max"
- "울트라" → "울트라" 
- "플러스" → "PLUS"
- "+" → "PLUS" (매우 중요!)
- "s25 +" → "S25 PLUS"
- "16프" → "16 PRO"
- "기변" → "기기변경"
- "번이" → "번호이동"

중요: 용량이 명시되지 않은 경우 256을 기본값으로 제안해주세요.

JSON 형식으로만 답변해주세요.
`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
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

        let gptResponse = response.choices[0].message.content.trim();

        // 코드블록 제거 (```json ```이나 ``` ``` 제거)
        gptResponse = gptResponse.replace(/```json\s*\n?/g, "");
        gptResponse = gptResponse.replace(/```\s*$/g, "");
        gptResponse = gptResponse.trim();

        // JSON 파싱 시도
        try {
            const parsed = JSON.parse(gptResponse);
            return parsed;
        } catch (e) {
            console.error("GPT JSON 파싱 실패:", e.message);
            return null;
        }
    } catch (error) {
        console.error("GPT 처리 중 오류:", error.message);
        return null;
    }
}

// —————— 7) 포맷팅 함수들 ——————
function formatAllConditions(records, modelInfo, commonServiceInfo) {
    const grouped = groupByTelecomAndChannelAndType(records);

    let result = `📱 ${modelInfo} 전체 가격 조건을 안내드려요:\n\n`;

    for (const telecom of TELECOMS) {
        if (grouped[telecom]) {
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

// —————— 8) Firebase Functions HTTP 엔드포인트 ——————
export const phonePrice = onRequest(
    {
        invoker: "public",
        cors: true,
        secrets: [openaiApiKey],
    },
    async (req, res) => {
        try {
            // CORS 헤더 설정
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Access-Control-Allow-Methods", "GET, POST");
            res.set("Access-Control-Allow-Headers", "Content-Type");

            if (req.method === "OPTIONS") {
                res.status(204).send("");
                return;
            }

            // 질문 추출 (GET 또는 POST 방식 지원)
            const question =
                req.method === "GET" ? req.query.question : req.body?.question;

            if (!question) {
                res.status(400).json({
                    error: "질문이 필요합니다.",
                    usage: 'GET: ?question=질문내용 또는 POST: {"question": "질문내용"}',
                });
                return;
            }

            // 구조 확인 요청 처리
            if (question === "구조확인" || question === "check") {
                const result = await checkSheetStructure(spreadsheetId.value());
                res.json({
                    type: "structure_check",
                    data: result,
                });
                return;
            }

            // 메인 로직 실행
            const { allRecords, commonServiceInfo } =
                await parseFullSheetStructure(spreadsheetId.value());
            const analysis = analyzeQuestion(question);
            const response = await generateResponse(
                analysis,
                allRecords,
                commonServiceInfo,
                openaiApiKey.value()
            );

            // 응답 반환
            res.json({
                question: question,
                scenario: analysis.primaryScenario,
                answer: response,
            });
        } catch (error) {
            console.error("Error details:", error);
            res.status(500).json({
                error: "서버 오류가 발생했습니다.",
                message: error.message,
                stack: error.stack,
                details: error.toString(),
            });
        }
    }
);

// —————— 9) 카카오톡 챗봇 스킬 엔드포인트 ——————
export const kakaoSkill = onRequest(
    {
        invoker: "public",
        cors: true,
        secrets: [openaiApiKey],
    },
    async (req, res) => {
        try {
            // CORS 헤더 설정
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Access-Control-Allow-Methods", "POST");
            res.set("Access-Control-Allow-Headers", "Content-Type");

            if (req.method === "OPTIONS") {
                res.status(204).send("");
                return;
            }

            // 카카오톡 스킬 요청 파싱
            const { userRequest, bot, contexts } = req.body;

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

            // 메인 로직 실행
            const { allRecords, commonServiceInfo } =
                await parseFullSheetStructure(spreadsheetId.value());
            const analysis = analyzeQuestion(question);
            const answer = await generateResponse(
                analysis,
                allRecords,
                commonServiceInfo,
                openaiApiKey.value()
            );

            // 카카오톡 스킬 응답 형식으로 변환
            const kakaoResponse = {
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
            };

            res.json(kakaoResponse);
        } catch (error) {
            console.error("카카오톡 스킬 오류:", error);

            // 에러 응답도 카카오톡 형식으로
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
