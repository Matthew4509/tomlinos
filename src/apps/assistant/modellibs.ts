// Written by tools/model-libs.mjs from the WebLLM this TOMLIN OS ships, then pinned by tools/pin-models.mjs --keep; do not edit by hand.
// Which of the MLC team's WebGPU programs runs which kind of model: key = architecture|compression|sizes.
export interface ModelLib { key: string; lib: string; sha256: string; vram: number; base: string; type: string; quant: string }
export const MODEL_LIBS: ModelLib[] = [
 {
  "key": "llama|q4f32_1|2048|8192|16|32|8|64|128256",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Llama-3.2-1B-Instruct-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "a1407404cb85b7dbc6db4bd77569291f02dab50aaeb1dc595b17595c2e204c66",
  "vram": 1129,
  "base": "Llama-3.2-1B-Instruct-q4f32_1-MLC",
  "type": "llama",
  "quant": "q4f32_1"
 },
 {
  "key": "llama|q4f16_1|2048|8192|16|32|8|64|128256",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "2aa9b5f0c8de532f6cbf6bb7b863aaa02645bf6fff856083b202f968712d3f92",
  "vram": 879,
  "base": "Llama-3.2-1B-Instruct-q4f16_1-MLC",
  "type": "llama",
  "quant": "q4f16_1"
 },
 {
  "key": "llama|q4f32_1|3072|8192|28|24|8|128|128256",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Llama-3.2-3B-Instruct-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "fac5f2303c170d8936ffef02498b8f645b17e98f4be83cfe2d081ea7304d0f67",
  "vram": 2952,
  "base": "Llama-3.2-3B-Instruct-q4f32_1-MLC",
  "type": "llama",
  "quant": "q4f32_1"
 },
 {
  "key": "llama|q4f16_1|3072|8192|28|24|8|128|128256",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Llama-3.2-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "79cc2f3794e32d9611675102a91d6ad1c8e869c1d5c3f7e8f8d26564d2f28efb",
  "vram": 2264,
  "base": "Llama-3.2-3B-Instruct-q4f16_1-MLC",
  "type": "llama",
  "quant": "q4f16_1"
 },
 {
  "key": "llama|q4f32_1|4096|14336|32|32|8|128|128256",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Llama-3_1-8B-Instruct-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "519907b908ab4d2ddb82f673cf6fd0f2e458675a8091d6a10c92ad4bd4ecb684",
  "vram": 6101,
  "base": "Llama-3.1-8B-Instruct-q4f32_1-MLC",
  "type": "llama",
  "quant": "q4f32_1"
 },
 {
  "key": "llama|q4f16_1|4096|14336|32|32|8|128|128256",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Llama-3_1-8B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "bbd0afeea1d5b1d741684426b98e6e2854be4397c37eb344199fb12b3e489202",
  "vram": 5001,
  "base": "Llama-3.1-8B-Instruct-q4f16_1-MLC",
  "type": "llama",
  "quant": "q4f16_1"
 },
 {
  "key": "mistral|q4f16_1|4096|14336|32|32|8|128|32032",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Mistral-7B-Instruct-v0.3-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "e2b2454cfc5958ef879a2839cecacfafb7af8947b7927e2ea72bc24dfc46db7d",
  "vram": 4033,
  "base": "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
  "type": "mistral",
  "quant": "q4f16_1"
 },
 {
  "key": "phi3|q4f16_1|3072|8192|32|32|32|96|32064",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Phi-3.5-mini-instruct-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "0342d0b660eb0d0415d37e4689c77bdab6dd2ca89cf5a44a0623d4c962e67c77",
  "vram": 3672,
  "base": "Phi-3.5-mini-instruct-q4f16_1-MLC",
  "type": "phi3",
  "quant": "q4f16_1"
 },
 {
  "key": "phi3|q4f32_1|3072|8192|32|32|32|96|32064",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Phi-3.5-mini-instruct-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "9818840b93e037c849b911d2fbd91e798d465036ffb098ab02c72ba627689418",
  "vram": 5483,
  "base": "Phi-3.5-mini-instruct-q4f32_1-MLC",
  "type": "phi3",
  "quant": "q4f32_1"
 },
 {
  "key": "phi3_v|q4f16_1|3072|8192|32|32|32|96|32064",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Phi-3.5-vision-instruct-q4f16_1_cs2k-webgpu.wasm",
  "sha256": "6af42cc69564ed5477de104ddeb407f4492e426cf3005b005f01b338dfa6c15c",
  "vram": 3952,
  "base": "Phi-3.5-vision-instruct-q4f16_1-MLC",
  "type": "phi3_v",
  "quant": "q4f16_1"
 },
 {
  "key": "phi3_v|q4f32_1|3072|8192|32|32|32|96|32064",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Phi-3.5-vision-instruct-q4f32_1_cs2k-webgpu.wasm",
  "sha256": "97874cf74a9fa6d779d357fae3a1db6c33d5caaf240d15ce83d35c109150ae70",
  "vram": 5880,
  "base": "Phi-3.5-vision-instruct-q4f32_1-MLC",
  "type": "phi3_v",
  "quant": "q4f32_1"
 },
 {
  "key": "phi3|q4f16_1|3072|8192|32|24|8|128|200064",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Phi-4-mini-instruct-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "5d24b86a0bab130f0ab04bd7a208294423ff69c8f35c3254c873bf17fb7020d6",
  "vram": 3438,
  "base": "Phi-4-mini-instruct-q4f16_1-MLC",
  "type": "phi3",
  "quant": "q4f16_1"
 },
 {
  "key": "phi3|q4f32_1|3072|8192|32|24|8|128|200064",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Phi-4-mini-instruct-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "2510318252d81184aae939aa5ad9afb1be15786b2c56d5a085b73c076607fadd",
  "vram": 4221,
  "base": "Phi-4-mini-instruct-q4f32_1-MLC",
  "type": "phi3",
  "quant": "q4f32_1"
 },
 {
  "key": "mistral|q4f32_1|4096|14336|32|32|8|128|32768",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Mistral-7B-Instruct-v0.3-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "8cc098eaeee438b9aa93ae0f6b569c37bdb93cd6956c9a19cd74a301f5c2c7de",
  "vram": 5619,
  "base": "Mistral-7B-Instruct-v0.3-q4f32_1-MLC",
  "type": "mistral",
  "quant": "q4f32_1"
 },
 {
  "key": "llama|q4f16_1|2048|8192|24|32|32|64|49152",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/SmolLM2-1.7B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "2f2842aeab20193f9149f705ed43d6702ca568d39c1f272790e1874ad96c15f4",
  "vram": 1774,
  "base": "SmolLM2-1.7B-Instruct-q4f16_1-MLC",
  "type": "llama",
  "quant": "q4f16_1"
 },
 {
  "key": "llama|q4f32_1|2048|8192|24|32|32|64|49152",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/SmolLM2-1.7B-Instruct-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "b016ced65a33def1a2195621b69eebdcef6942c7cae3a5898cb5426e22f74a34",
  "vram": 2692,
  "base": "SmolLM2-1.7B-Instruct-q4f32_1-MLC",
  "type": "llama",
  "quant": "q4f32_1"
 },
 {
  "key": "llama|q4f16_1|960|2560|32|15|5|64|49152",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/SmolLM2-360M-Instruct-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "5c20098605780550c40e9c64d288dd6e369707a08d4133037156019b064ad41b",
  "vram": 376,
  "base": "SmolLM2-360M-Instruct-q4f16_1-MLC",
  "type": "llama",
  "quant": "q4f16_1"
 },
 {
  "key": "llama|q4f32_1|960|2560|32|15|5|64|49152",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/SmolLM2-360M-Instruct-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "64d0c417a2154906c18e5d25392a2538e1bcd4ca67f5374782b467da23a29667",
  "vram": 580,
  "base": "SmolLM2-360M-Instruct-q4f32_1-MLC",
  "type": "llama",
  "quant": "q4f32_1"
 },
 {
  "key": "gemma2|q4f16_1|2304|9216|26|8|4|256|256000",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/gemma-2-2b-it-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "a1e849029df21b68674bbd811f5b1d6d58cc8c22689bb580dc19faf53d7be364",
  "vram": 1895,
  "base": "gemma-2-2b-it-q4f16_1-MLC",
  "type": "gemma2",
  "quant": "q4f16_1"
 },
 {
  "key": "gemma2|q4f32_1|2304|9216|26|8|4|256|256000",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/gemma-2-2b-it-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "1f9d0ca4a8b0edf87c2f3326948baa61fdf5f05223bb322f5e26caa8240d16e7",
  "vram": 2509,
  "base": "gemma-2-2b-it-q4f32_1-MLC",
  "type": "gemma2",
  "quant": "q4f32_1"
 },
 {
  "key": "gemma2|q4f16_1|3584|14336|42|16|8|256|256000",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/gemma-2-9b-it-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "9958fe5a0c12a51b24d767e5b5c0d9249e8ba01422f5dcbc0e4b4e823024b954",
  "vram": 6422,
  "base": "gemma-2-9b-it-q4f16_1-MLC",
  "type": "gemma2",
  "quant": "q4f16_1"
 },
 {
  "key": "gemma2|q4f32_1|3584|14336|42|16|8|256|256000",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/gemma-2-9b-it-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "27db561d396c56e691a859f9e3c6c50f289b7711f25fafb06876c2270b6e36a3",
  "vram": 8383,
  "base": "gemma-2-9b-it-q4f32_1-MLC",
  "type": "gemma2",
  "quant": "q4f32_1"
 },
 {
  "key": "gemma3|q4f16_1|||||||262144",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/gemma3-1b-it-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "c608d6eb62de3b7dd7444d3d48088f073e3b68a719dfe77e111efac70dd2e165",
  "vram": 711,
  "base": "gemma3-1b-it-q4f16_1-MLC",
  "type": "gemma3",
  "quant": "q4f16_1"
 },
 {
  "key": "olmo2|q4f16_1|4096|11008|32|32|32|128|100352",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/OLMo-2-1124-7B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "407a1430911b5912e7cb66aca9486b90152253408e84669771484d1978bc1758",
  "vram": 6479,
  "base": "OLMo-2-1124-7B-Instruct-q4f16_1-MLC",
  "type": "olmo2",
  "quant": "q4f16_1"
 },
 {
  "key": "olmo2|q4f32_1|4096|11008|32|32|32|128|100352",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/OLMo-2-1124-7B-Instruct-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "02025c574b0adbd20111d982c0dda33fe759e41bc260b30a312f4b15a7f50aee",
  "vram": 9086,
  "base": "OLMo-2-1124-7B-Instruct-q4f32_1-MLC",
  "type": "olmo2",
  "quant": "q4f32_1"
 },
 {
  "key": "olmo2|q4f16_1|2048|8192|16|16|16|128|100352",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/OLMo-2-0425-1B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "b581aa534e304c1d15956acbca9e4f8f53786ba51b827b2b14819a82e6852194",
  "vram": 1777,
  "base": "OLMo-2-0425-1B-Instruct-q4f16_1-MLC",
  "type": "olmo2",
  "quant": "q4f16_1"
 },
 {
  "key": "olmo2|q4f32_1|2048|8192|16|16|16|128|100352",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/OLMo-2-0425-1B-Instruct-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "0717a79936dddc206f9484e818be664673bb11a9b969d994e7c60eae70e4d04c",
  "vram": 2454,
  "base": "OLMo-2-0425-1B-Instruct-q4f32_1-MLC",
  "type": "olmo2",
  "quant": "q4f32_1"
 },
 {
  "key": "qwen3|q4f16_1|1024|3072|28|16|8|128|151936",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "4db800b24119204e1a0386e8a12e084d5012aa60f77c5bffad362f20498df912",
  "vram": 1403,
  "base": "Qwen3-0.6B-q4f16_1-MLC",
  "type": "qwen3",
  "quant": "q4f16_1"
 },
 {
  "key": "qwen3|q4f32_1|1024|3072|28|16|8|128|151936",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3-0.6B-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "361f1310ae616863bccbc638f075f7484816b45eb30ffecf08539272a1b2ae1e",
  "vram": 1925,
  "base": "Qwen3-0.6B-q4f32_1-MLC",
  "type": "qwen3",
  "quant": "q4f32_1"
 },
 {
  "key": "qwen3|q4f16_1|2048|6144|28|16|8|128|151936",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3-1.7B-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "8161aaa4b40bccf19fcedb2f2e8c221eb9efb72d2198681f1958c9c1e05a682f",
  "vram": 2037,
  "base": "Qwen3-1.7B-q4f16_1-MLC",
  "type": "qwen3",
  "quant": "q4f16_1"
 },
 {
  "key": "qwen3|q4f32_1|2048|6144|28|16|8|128|151936",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3-1.7B-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "a80ca0d245ed9ce492497918afd21ec1d43dd3873b63591255b01bd9c41adf65",
  "vram": 2635,
  "base": "Qwen3-1.7B-q4f32_1-MLC",
  "type": "qwen3",
  "quant": "q4f32_1"
 },
 {
  "key": "qwen3|q4f16_1|2560|9728|36|32|8|128|151936",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3-4B-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "a986a53c92579714eb7ec36856004f5fb75272c9f69091f14eb6b2086eea4440",
  "vram": 3432,
  "base": "Qwen3-4B-q4f16_1-MLC",
  "type": "qwen3",
  "quant": "q4f16_1"
 },
 {
  "key": "qwen3|q4f32_1|2560|9728|36|32|8|128|151936",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3-4B-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "d4ad6b142902f55d724480c785274516cfc72e2bf1678c5a941845c427dc77b2",
  "vram": 4328,
  "base": "Qwen3-4B-q4f32_1-MLC",
  "type": "qwen3",
  "quant": "q4f32_1"
 },
 {
  "key": "qwen3|q4f16_1|4096|12288|36|32|8|128|151936",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3-8B-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "bf6384d9b30d6ae1eca567c65a893284ae2228fd57a432c3b795d06a803d9b72",
  "vram": 5696,
  "base": "Qwen3-8B-q4f16_1-MLC",
  "type": "qwen3",
  "quant": "q4f16_1"
 },
 {
  "key": "qwen3|q4f32_1|4096|12288|36|32|8|128|151936",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3-8B-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "7ccfb46dbd65813ec6746b1920fd56bac01f6378ea55a0a189dbc41f7bc9e6ee",
  "vram": 6853,
  "base": "Qwen3-8B-q4f32_1-MLC",
  "type": "qwen3",
  "quant": "q4f32_1"
 },
 {
  "key": "qwen3_5|q4f16_1|1024|3584|24|8|2|256|248320",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3.5-0.8B-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "3dd8cff049bf4599bfbb505880aea11ba95f85f3924b7e171f967d1f1348ae29",
  "vram": 1629,
  "base": "Qwen3.5-0.8B-q4f16_1-MLC",
  "type": "qwen3_5",
  "quant": "q4f16_1"
 },
 {
  "key": "qwen3_5|q4f32_1|1024|3584|24|8|2|256|248320",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3.5-0.8B-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "48232ec3bc756521463ca9bc49ff036d82ea9c7930d2a41ef6d9bfb20e5c684d",
  "vram": 1894,
  "base": "Qwen3.5-0.8B-q4f32_1-MLC",
  "type": "qwen3_5",
  "quant": "q4f32_1"
 },
 {
  "key": "qwen3_5|q4f16_1|2048|6144|24|8|2|256|248320",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3.5-2B-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "b0f951d411e4fd59fe2af76be9328905ae30549e570a192a841c958b293ecd53",
  "vram": 2245,
  "base": "Qwen3.5-2B-q4f16_1-MLC",
  "type": "qwen3_5",
  "quant": "q4f16_1"
 },
 {
  "key": "qwen3_5|q4f32_1|2048|6144|24|8|2|256|248320",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3.5-2B-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "0fc73363adf9b9c81f652421138b61bec238a1387b01c8fccffd9d3ea45be9dd",
  "vram": 2592,
  "base": "Qwen3.5-2B-q4f32_1-MLC",
  "type": "qwen3_5",
  "quant": "q4f32_1"
 },
 {
  "key": "qwen3_5|q4f16_1|2560|9216|32|16|4|256|248320",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3.5-4B-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "7e8f9895daa710a83952efac4d5c6f36e9f89dc684b25022746d881bdc904712",
  "vram": 3868,
  "base": "Qwen3.5-4B-q4f16_1-MLC",
  "type": "qwen3_5",
  "quant": "q4f16_1"
 },
 {
  "key": "qwen3_5|q4f32_1|2560|9216|32|16|4|256|248320",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3.5-4B-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "962631a35cdf091ed2d4f2199d1ea22fc3bb9cd02eb0426e0fd5da5fdb5375cd",
  "vram": 4680,
  "base": "Qwen3.5-4B-q4f32_1-MLC",
  "type": "qwen3_5",
  "quant": "q4f32_1"
 },
 {
  "key": "qwen3_5|q4f16_1|4096|12288|32|16|4|256|248320",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3.5-9B-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "3014c1d8958083edf621145596a6d7a832178aef2aefe48a0dbde16d38f7c857",
  "vram": 6433,
  "base": "Qwen3.5-9B-q4f16_1-MLC",
  "type": "qwen3_5",
  "quant": "q4f16_1"
 },
 {
  "key": "qwen3_5|q4f32_1|4096|12288|32|16|4|256|248320",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3.5-9B-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "7770d46861d7d047b36f5776f2a0751fb5ca6ee315f0b972d12967cdac20090b",
  "vram": 7545,
  "base": "Qwen3.5-9B-q4f32_1-MLC",
  "type": "qwen3_5",
  "quant": "q4f32_1"
 },
 {
  "key": "stablelm|q4f16_1|2048|5632|24|32|32|64|100352",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/stablelm-2-zephyr-1_6b-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "404e18551f880b7935c1c57561898eb686e00bf89c3cb543acfefd4bab9a373d",
  "vram": 2088,
  "base": "stablelm-2-zephyr-1_6b-q4f16_1-MLC",
  "type": "stablelm",
  "quant": "q4f16_1"
 },
 {
  "key": "stablelm|q4f32_1|2048|5632|24|32|32|64|100352",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/stablelm-2-zephyr-1_6b-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "3d70e46ca3b3c79199eb13a3d6230bd3a372e97a95cc8839b9f05cd80a0c4b9d",
  "vram": 2999,
  "base": "stablelm-2-zephyr-1_6b-q4f32_1-MLC",
  "type": "stablelm",
  "quant": "q4f32_1"
 },
 {
  "key": "gpt_neox|q4f16_1|2560|10240|32|32||80|50432",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/RedPajama-INCITE-Chat-3B-v1-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "bfe8fc46926481e547b3b47bbbb0ecf20334ed6148c77e5a30b6cdb6ad20ada3",
  "vram": 2972,
  "base": "RedPajama-INCITE-Chat-3B-v1-q4f16_1-MLC",
  "type": "gpt_neox",
  "quant": "q4f16_1"
 },
 {
  "key": "gpt_neox|q4f32_1|2560|10240|32|32||80|50432",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/RedPajama-INCITE-Chat-3B-v1-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "d7ea748ddd12dc4f6b9d948590acae3d08b56e83f7127f9bbbdfaab50cd8a2fa",
  "vram": 3928,
  "base": "RedPajama-INCITE-Chat-3B-v1-q4f32_1-MLC",
  "type": "gpt_neox",
  "quant": "q4f32_1"
 },
 {
  "key": "llama|q4f16_1|2048|5632|22|32|4|64|32000",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/TinyLlama-1.1B-Chat-v1.0-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "843ee745703f41e716740ceecdbf5cdb27e7a28df35b68aad909c7df6b1573ea",
  "vram": 697,
  "base": "TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC",
  "type": "llama",
  "quant": "q4f16_1"
 },
 {
  "key": "llama|q4f32_1|2048|5632|22|32|4|64|32000",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/TinyLlama-1.1B-Chat-v1.0-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "1ca145463bed8d1cbaeb1838f8d75946f3ed109e2d5df58b841a6258b2a49af5",
  "vram": 840,
  "base": "TinyLlama-1.1B-Chat-v1.0-q4f32_1-MLC",
  "type": "llama",
  "quant": "q4f32_1"
 },
 {
  "key": "ministral3|q4f16_1|3072|9216|26|32|8|128|131072",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Ministral-3-3B-Base-2512-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "a41ea60810292a195d06458f6219e46207c229a957f31dd420edc937c83c2258",
  "vram": 2864,
  "base": "Ministral-3-3B-Base-2512-q4f16_1-MLC",
  "type": "ministral3",
  "quant": "q4f16_1"
 },
 {
  "key": "ministral3|q4f32_1|3072|9216|26|32|8|128|131072",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Ministral-3-3B-Base-2512-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "e903e898733a6329231ca930e499eba5924030eea4e6e85221f47563ab019f2c",
  "vram": 3532,
  "base": "Ministral-3-3B-Base-2512-q4f32_1-MLC",
  "type": "ministral3",
  "quant": "q4f32_1"
 },
 {
  "key": "llama|q4f32_1|4096|11008|32|32|32|128|32000",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Llama-2-7b-chat-hf-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "f5f5bf700fb3667e4e6696cc8f79a43a4239453aa75e8cd312fff5f0c4fd73b1",
  "vram": 9109,
  "base": "Llama-2-7b-chat-hf-q4f32_1-MLC",
  "type": "llama",
  "quant": "q4f32_1"
 },
 {
  "key": "llama|q4f16_1|4096|11008|32|32|32|128|32000",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Llama-2-7b-chat-hf-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "e4a2f29e5aaa6a47b69d7c930ef541cfa4eac543d9edc5d0a2f310ef43243ce2",
  "vram": 6749,
  "base": "Llama-2-7b-chat-hf-q4f16_1-MLC",
  "type": "llama",
  "quant": "q4f16_1"
 },
 {
  "key": "llama|q4f16_1|5120|13824|40|40|40|128|32000",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Llama-2-13b-chat-hf-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "a589d2043cc40f5272387cc4e6b42bf28aad11701e8ee7fa28d9b154d0e2ed4e",
  "vram": 11814,
  "base": "Llama-2-13b-chat-hf-q4f16_1-MLC",
  "type": "llama",
  "quant": "q4f16_1"
 },
 {
  "key": "gemma|q4f16_1|2048|16384|18|8|1|256|256000",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/gemma-2b-it-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "935c6de0976baa1b32abfb9cde8a7940bb9d7a560d9ca3fbd4886dee5e61130d",
  "vram": 1477,
  "base": "gemma-2b-it-q4f16_1-MLC",
  "type": "gemma",
  "quant": "q4f16_1"
 },
 {
  "key": "gemma|q4f32_1|2048|16384|18|8|1|256|256000",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/gemma-2b-it-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "392d9041aa122e56623822df7662f45d1e64a5a49f169c1042c9fa1911a82332",
  "vram": 1751,
  "base": "gemma-2b-it-q4f32_1-MLC",
  "type": "gemma",
  "quant": "q4f32_1"
 },
 {
  "key": "phi-msft|q4f16_1||||||80|51200",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/phi-2-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "b89abe35524310f85db3fc533144ff2bf8e8a840adb0d4ff834361bdf4e4b187",
  "vram": 3054,
  "base": "phi-2-q4f16_1-MLC",
  "type": "phi-msft",
  "quant": "q4f16_1"
 },
 {
  "key": "phi-msft|q4f32_1||||||80|51200",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/phi-2-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "ca5b18c376b53067a317dc14f13103bce26c256ec2499d96b30fadd1586b122e",
  "vram": 4032,
  "base": "phi-2-q4f32_1-MLC",
  "type": "phi-msft",
  "quant": "q4f32_1"
 },
 {
  "key": "phi-msft|q4f16_1||||||64|51200",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/phi-1_5-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "853591c72bf9079f8705b16d2ecf7eb50ee6a9f80eeacb60ec6c50ecab44ee8d",
  "vram": 1210,
  "base": "phi-1_5-q4f16_1-MLC",
  "type": "phi-msft",
  "quant": "q4f16_1"
 },
 {
  "key": "phi-msft|q4f32_1||||||64|51200",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/phi-1_5-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "c651dac7a25eb262f1cfe64c73ea9343f20a71ba60ee8efdb99a6f90f507864e",
  "vram": 1682,
  "base": "phi-1_5-q4f32_1-MLC",
  "type": "phi-msft",
  "quant": "q4f32_1"
 },
 {
  "key": "llama|q4f16_1|2048|5632|22|32|4|64|32003",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/TinyLlama-1.1B-Chat-v0.4-q4f16_1_cs1k-webgpu.wasm",
  "sha256": "266fcc4ab1dc813909c7215d2e2ebbcb7eaefe178dc821067dcec1a5bb426022",
  "vram": 697,
  "base": "TinyLlama-1.1B-Chat-v0.4-q4f16_1-MLC",
  "type": "llama",
  "quant": "q4f16_1"
 },
 {
  "key": "llama|q4f32_1|2048|5632|22|32|4|64|32003",
  "lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/TinyLlama-1.1B-Chat-v0.4-q4f32_1_cs1k-webgpu.wasm",
  "sha256": "c030a40e7be0ce87ac45e364c711eac0f8b3a93237af0178c9d56009f568a2d3",
  "vram": 840,
  "base": "TinyLlama-1.1B-Chat-v0.4-q4f32_1-MLC",
  "type": "llama",
  "quant": "q4f32_1"
 }
];
