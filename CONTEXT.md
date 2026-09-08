# Antigravity Provider Context

Pi Coding Agent를 위한 Google Antigravity 연동 확장 프로그램의 도메인 모델.

## Language

### Wire & Protocol

**Wire Fingerprint**:
공식 `agy` CLI가 백엔드와 통신할 때 네트워크상에 드러나는 관측 가능한 요청/응답의 형태(엔드포인트, HTTP 헤더, 엔벨로프 구조 등).
_Avoid_: Wire format, API schema, traffic dump

**Capture Fixture**:
공식 `agy` CLI의 특정 버전에서 `mitmproxy`로 추출하여 `captures/agy_cli_{version}/`에 규격화해 보관하는 실제 요청/응답 원본 데이터.
_Avoid_: Mock data, dummy payload, test sample

**Turn Trace**:
`thoughtSignature`와 도구 호출(`functionCall`/`functionResponse`) 상태 전파를 검증하기 위해 최소 5턴 이상의 연속 대화를 기록한 캡처 데이터.
_Avoid_: Chat history, message log, turn dump

**Thought Signature**:
Gemini 3.x 계열 모델이 멀티턴 대화나 도구 호출 시 이전 사고(thinking) 블록의 연속성을 증명하기 위해 백엔드에 반드시 반환해야 하는 검증 토큰.
_Avoid_: Thought token, thinking hash, thought checksum

**Turn Trace Request Builder**:
대화 이력(Turn Trace)과 Model Plan을 입력받아 세션 식별자 파생, Thought Signature 검증, 도구 스키마 변환을 캡슐화하여 백엔드가 요구하는 단일 Wire Fingerprint 요청 엔벨로프로 조립하는 모듈.
_Avoid_: Request serializer, payload generator, message mapper

### Models & Routing

**Public Model ID**:
Pi의 모델 선택 UI(`/model`)에서 사용자에게 노출되는 정규화된 모델 식별자 (예: `gemini-3.8-flash`, `claude-sonnet-4-6`).
_Avoid_: Display name, UI alias

**Runtime Model ID**:
Google Antigravity 백엔드 API가 실제로 요청 바디에서 요구하는 내부 모델 식별자 (예: `gemini-3.8-flash-high`, `gemini-pro-agent`).
_Avoid_: Backend model, internal model, actual ID

**Model Catalog**:
백엔드의 `fetchAvailableModels` API를 동적으로 조회하여 Pi의 `Public Model ID`와 `Runtime Model ID` 매핑으로 변환한 모델 집합.
_Avoid_: Model registry, model list, model table

**Catalog Persistence**:
Pi 코어가 `~/.config/pi/models-store.json`을 통해 제공하는 원격 모델 카탈로그의 표준 로컬 캐시 및 오프라인 복원 메커니즘.
_Avoid_: Model cache, local storage, custom catalog file

**Model Plan**:
하나의 `Public Model ID`와 thinking effort 조합에 대해 `Model Catalog`가 한 번에 해결하는 묶음 (`Runtime Model ID`, 모델 enum, thinking budget, non-Gemini 여부, Claude 여부).
_Avoid_: Resolved model, model config, runtime bundle

**Model Family**:
Thought Signature replay 가능 여부를 가르는 `Runtime Model ID` 그룹 (`gemini-`/`claude-`/`gpt-` prefix + base-id 동등성). 같은 family 안에서만 signature를 이어붙인다.
_Avoid_: Model group, vendor prefix

### Quota & Account

**Quota Pool**:
Google 계정의 티어에 따라 모델 그룹(Gemini 풀, Claude/GPT-OSS 풀 등)이 5시간 및 주간 단위로 공유하는 사용량 한도.
_Avoid_: Rate limit, token bucket, credit

**Quota Status**:
Footer slot에 표시되는 Quota Pool 잔량 요약과 그 뒤의 갱신·보정 책임.
_Avoid_: Quota widget

### Interface

**Subcommand**:
`/antigravity` 단일 루트 커맨드 뒤에 붙어 세부 동작을 지시하는 인자 (`usage`, `models`, `refresh`, `login`).
_Avoid_: Command flag, option, action
