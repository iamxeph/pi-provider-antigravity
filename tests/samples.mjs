// Synthetic wire samples for unit tests: trimmed shapes of the Antigravity backend's
// responses, carrying only the fields the code under test reads. They are not refreshed
// per agy release; edit them by hand when a test needs a new shape.

export const MODELS_RESPONSE = {
  agentModelSorts: [{"displayName":"Recommended","groups":[{"modelIds":["gemini-4-argon-medium","gemini-4-argon-high","gemini-4-argon-low","gemini-3.8-flash-high","gemini-3.8-flash-medium","gemini-3.8-flash-low","claude-opus-5-5-low","claude-opus-5-5-medium","claude-opus-5-5-high","claude-sonnet-5-5-low","claude-sonnet-5-5-medium","claude-sonnet-5-5-high","gpt-oss-120b-medium"]}]}],
  models: {
    "claude-sonnet-5-5-low": {"displayName":"Claude Sonnet 5.5 (Low)","supportsThinking":true,"thinkingLevel":1,"supportsImages":true,"maxTokens":1000000,"maxOutputTokens":128000,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M403"},
    "gemini-4-argon-high": {"displayName":"Gemini 4 Argon (High)","supportsThinking":true,"thinkingLevel":3,"supportsImages":true,"maxTokens":1048576,"maxOutputTokens":65536,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M417"},
    "tab_flash_lite_preview": {"maxTokens":16384,"maxOutputTokens":4096,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M19"},
    "gemini-3.8-flash-tiered": {"supportsThinking":true,"thinkingLevel":3,"supportsImages":true,"maxTokens":1048576,"maxOutputTokens":65536,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M322"},
    "gemini-2.5-pro": {"displayName":"Gemini 2.5 Pro","supportsThinking":true,"thinkingBudget":1024,"supportsImages":true,"maxTokens":1048576,"maxOutputTokens":65535,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_GOOGLE_GEMINI_2_5_PRO"},
    "gemini-3.1-flash-image": {"displayName":"Gemini 3.1 Flash Image","supportsImages":true,"maxTokens":65536,"maxOutputTokens":65536,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M21"},
    "claude-opus-5-5-medium": {"displayName":"Claude Opus 5.5 (Medium)","supportsThinking":true,"thinkingLevel":2,"supportsImages":true,"maxTokens":1000000,"maxOutputTokens":128000,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M401"},
    "gemini-3-flash": {"displayName":"Gemini 3 Flash","supportsThinking":true,"thinkingLevel":3,"supportsImages":true,"maxTokens":1048576,"maxOutputTokens":65536,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M18"},
    "claude-opus-5-5-low": {"displayName":"Claude Opus 5.5 (Low)","supportsThinking":true,"thinkingLevel":1,"supportsImages":true,"maxTokens":1000000,"maxOutputTokens":128000,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M400"},
    "gemini-4-argon-low": {"displayName":"Gemini 4 Argon (Low)","supportsThinking":true,"thinkingLevel":1,"supportsImages":true,"maxTokens":1048576,"maxOutputTokens":65536,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M419"},
    "claude-sonnet-5-5-high": {"displayName":"Claude Sonnet 5.5 (High)","supportsThinking":true,"thinkingLevel":3,"supportsImages":true,"maxTokens":1000000,"maxOutputTokens":128000,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M405"},
    "tab_jump_flash_lite_preview": {"maxTokens":16384,"maxOutputTokens":4096,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M28"},
    "gemini-2.5-flash-thinking": {"displayName":"Gemini 3.5 Flash Lite","supportsThinking":true,"thinkingLevel":1,"supportsImages":true,"maxTokens":1048576,"maxOutputTokens":65535,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING"},
    "gemini-3.8-flash-high": {"displayName":"Gemini 3.8 Flash (High)","supportsThinking":true,"thinkingLevel":3,"supportsImages":true,"maxTokens":1048576,"maxOutputTokens":65536,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M318"},
    "gemini-4-argon-medium": {"displayName":"Gemini 4 Argon (Medium)","supportsThinking":true,"thinkingLevel":2,"supportsImages":true,"maxTokens":1048576,"maxOutputTokens":65536,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M418"},
    "gemini-3.5-flash-lite": {"displayName":"Gemini 3.5 Flash Lite","supportsThinking":true,"thinkingLevel":1,"supportsImages":true,"maxTokens":1048576,"maxOutputTokens":65535,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M198"},
    "gemini-2.5-flash": {"displayName":"Gemini 3.5 Flash Lite","supportsThinking":true,"thinkingLevel":1,"supportsImages":true,"maxTokens":1048576,"maxOutputTokens":65535,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_GOOGLE_GEMINI_2_5_FLASH"},
    "chat_20706": {"maxTokens":16384,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_CHAT_20706"},
    "gemini-3.1-flash-lite": {"displayName":"Gemini 3.1 Flash Lite","supportsThinking":true,"thinkingLevel":1,"supportsImages":true,"maxTokens":1048576,"maxOutputTokens":65535,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M50"},
    "claude-sonnet-5-5-medium": {"displayName":"Claude Sonnet 5.5 (Medium)","supportsThinking":true,"thinkingLevel":2,"supportsImages":true,"maxTokens":1000000,"maxOutputTokens":128000,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M404"},
    "gemini-2.5-flash-lite": {"displayName":"Gemini 3.5 Flash Lite","supportsThinking":true,"thinkingLevel":1,"supportsImages":true,"maxTokens":1048576,"maxOutputTokens":65535,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE"},
    "chat_23310": {"maxTokens":32768,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_CHAT_23310"},
    "gpt-oss-120b-medium": {"displayName":"GPT-OSS 120B (Medium)","supportsThinking":true,"thinkingBudget":8192,"maxTokens":131072,"maxOutputTokens":32768,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_OPENAI_GPT_OSS_120B_MEDIUM"},
    "gemini-3.8-flash-low": {"displayName":"Gemini 3.8 Flash (Low)","supportsThinking":true,"thinkingLevel":1,"supportsImages":true,"maxTokens":1048576,"maxOutputTokens":65536,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M320"},
    "gemini-3.8-flash-medium": {"displayName":"Gemini 3.8 Flash (Medium)","supportsThinking":true,"thinkingLevel":2,"supportsImages":true,"maxTokens":1048576,"maxOutputTokens":65536,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M319"},
    "claude-opus-5-5-high": {"displayName":"Claude Opus 5.5 (High)","supportsThinking":true,"thinkingLevel":3,"supportsImages":true,"maxTokens":1000000,"maxOutputTokens":128000,"quotaInfo":{"remainingFraction":0.9,"resetTime":"2026-12-31T23:59:59Z"},"model":"MODEL_PLACEHOLDER_M402"},
  },
};

export const QUOTA_RESPONSE = {
  "groups": [
    {
      "buckets": [
        {
          "bucketId": "gemini-weekly",
          "displayName": "Weekly Limit Remaining",
          "window": "weekly",
          "resetTime": "2026-12-31T23:59:59Z",
          "description": "Mock quota for Weekly Limit Remaining",
          "remainingFraction": 0.9
        },
        {
          "bucketId": "gemini-5h",
          "displayName": "Five Hour Limit Remaining",
          "window": "5h",
          "resetTime": "2026-12-31T23:59:59Z",
          "description": "Mock quota for Five Hour Limit Remaining",
          "remainingFraction": 0.85
        }
      ],
      "displayName": "Gemini Models",
      "description": "Models within this group: Gemini Flash, Gemini Pro"
    },
    {
      "buckets": [
        {
          "bucketId": "3p-weekly",
          "displayName": "Weekly Limit Remaining",
          "window": "weekly",
          "resetTime": "2026-12-31T23:59:59Z",
          "description": "Mock quota for Weekly Limit Remaining",
          "remainingFraction": 0.9
        },
        {
          "bucketId": "3p-5h",
          "displayName": "Five Hour Limit Remaining",
          "window": "5h",
          "resetTime": "2026-12-31T23:59:59Z",
          "description": "Mock quota for Five Hour Limit Remaining",
          "remainingFraction": 0.85
        }
      ],
      "displayName": "Claude and GPT models",
      "description": "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS"
    },
    {
      "buckets": [
        {
          "bucketId": "gemini-argon-wtu-weekly",
          "displayName": "Gemini 4 Argon Weekly Limit",
          "window": "weekly",
          "resetTime": "2026-12-31T23:59:59Z",
          "description": "Mock quota for Gemini 4 Argon Weekly Limit",
          "remainingFraction": 0.9
        }
      ],
      "displayName": "Gemini 4 Argon",
      "description": "For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans."
    }
  ],
  "description": "Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens. Thus, limits will last longer with shorter tasks or using more cost-effective models. The 5-hour limit smooths out aggregate demand to fairly distribute global capacity across all users, while your weekly limit is tied directly to your individual tier."
};

// Turn 1: a thinking part, then a functionCall carrying the signature, then an empty STOP.
export const SSE_TOOL_CALL = String.raw`data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"thought": true,"text": "The task is to save a note to a specified file. The file path and content are provided, along with overwrite permission. Now, I will prepare the note using these inputs to use the available tool to save the change. I will confirm the file operation completion.\n\n\n"}]}}],"usageMetadata": {"promptTokenCount": 6866,"totalTokenCount": 7017,"thoughtsTokenCount": 151},"modelVersion": "gemini-3.8-flash-n","responseId": "mock-response-id-0001"},"traceId": "0000000000000001","metadata": {}}

data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"thoughtSignature": "TU9DS19USE9VR0hUX1NJR05BVFVSRV9GT1JfVEVTVF8wMDAx","functionCall": {"name": "write_file","args": {"Content": "The deploy has been moved to Thursday.\n","Path": "/tmp/work/notes.txt","Overwrite": true},"id": "call_584179"}}]}}],"usageMetadata": {"promptTokenCount": 6866,"candidatesTokenCount": 41,"totalTokenCount": 7094,"thoughtsTokenCount": 187},"modelVersion": "gemini-3.8-flash-n","responseId": "mock-response-id-0001"},"traceId": "0000000000000001","metadata": {}}

data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"text": ""}]},"finishReason": "STOP"}],"usageMetadata": {"promptTokenCount": 6866,"candidatesTokenCount": 41,"totalTokenCount": 7094,"thoughtsTokenCount": 187},"modelVersion": "gemini-3.8-flash-n","responseId": "mock-response-id-0001"},"traceId": "0000000000000001","metadata": {}}

`;

// Turn 4: visible text, then the signature alone on an empty STOP part.
export const SSE_TEXT_SIGNATURE = String.raw`data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"text": "The average speed of the train is 80 km/h."}]}}],"usageMetadata": {"promptTokenCount": 7226,"candidatesTokenCount": 14,"totalTokenCount": 7413,"thoughtsTokenCount": 173},"modelVersion": "gemini-3.8-flash-n","responseId": "mock-response-id-0002"},"traceId": "0000000000000002","metadata": {}}

data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"thoughtSignature": "TU9DS19USE9VR0hUX1NJR05BVFVSRV9GT1JfVEVTVF8wMDAz","text": ""}]},"finishReason": "STOP"}],"usageMetadata": {"promptTokenCount": 7544,"candidatesTokenCount": 14,"totalTokenCount": 7731,"thoughtsTokenCount": 173},"modelVersion": "gemini-3.8-flash-n","responseId": "mock-response-id-0002"},"traceId": "0000000000000002","metadata": {}}

`;

// Turn 5: a one-word answer, then the signature alone on an empty STOP part.
export const SSE_SHORT_ANSWER = String.raw`data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"text": "done"}]}}],"usageMetadata": {"promptTokenCount": 7443,"candidatesTokenCount": 1,"totalTokenCount": 7471,"thoughtsTokenCount": 27},"modelVersion": "gemini-3.8-flash-n","responseId": "mock-response-id-0003"},"traceId": "0000000000000003","metadata": {}}

data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"thoughtSignature": "TU9DS19USE9VR0hUX1NJR05BVFVSRV9GT1JfVEVTVF8wMDA2","text": ""}]},"finishReason": "STOP"}],"usageMetadata": {"promptTokenCount": 7934,"candidatesTokenCount": 1,"totalTokenCount": 7962,"thoughtsTokenCount": 27},"modelVersion": "gemini-3.8-flash-n","responseId": "mock-response-id-0003"},"traceId": "0000000000000003","metadata": {}}

`;
