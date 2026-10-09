// "Good places to start" in Find AI models: a few well-known models by the kind of computer, so a person does not have
// to know names before searching. Only models the built-in engine has a program for (modellibs.ts), published by the
// MLC team on Hugging Face. The graphics memory shown comes from that program's own figure, never typed here. A
// computer whose graphics chip has no half-precision support (older ones) gets the q4f32 build; others get q4f16, which
// is smaller and quicker.
import { MODEL_LIBS } from './modellibs.ts';
import { BUILT_IN_MODELS } from './engine.ts';

export interface SuggestedModel {
  /** The repository name without its compression part ("Llama-3.2-1B-Instruct"). */
  base: string;
  name: string;
  maker: string;
}

export interface SuggestedGroup {
  title: string;
  /** The kind of computer, in plain words. */
  spec: string;
  models: SuggestedModel[];
}

export const SUGGESTED: SuggestedGroup[] = [
  {
    title: 'Older or basic computers',
    spec: 'graphics built into the processor, 8 GB of memory',
    models: [
      { base: 'SmolLM2-360M-Instruct', name: 'SmolLM2 360M', maker: 'Hugging Face' },
      { base: 'Qwen3.5-0.8B', name: 'Qwen 3.5 0.8B', maker: 'Qwen team, Alibaba Cloud' },
      { base: 'Llama-3.2-1B-Instruct', name: 'Llama 3.2 1B', maker: 'Meta' },
    ],
  },
  {
    title: 'Everyday computers',
    spec: 'newer built-in graphics, 16 GB of memory',
    models: [
      { base: 'Qwen3.5-2B', name: 'Qwen 3.5 2B', maker: 'Qwen team, Alibaba Cloud' },
      { base: 'gemma-2-2b-it', name: 'Gemma 2 2B', maker: 'Google' },
      { base: 'Llama-3.2-3B-Instruct', name: 'Llama 3.2 3B', maker: 'Meta' },
    ],
  },
  {
    title: 'Computers with a graphics card',
    spec: 'a graphics card with 6 GB of its own memory or more',
    models: [
      { base: 'Qwen3.5-4B', name: 'Qwen 3.5 4B', maker: 'Qwen team, Alibaba Cloud' },
      { base: 'Phi-4-mini-instruct', name: 'Phi-4 mini', maker: 'Microsoft' },
      { base: 'Qwen3.5-9B', name: 'Qwen 3.5 9B', maker: 'Qwen team, Alibaba Cloud' },
      { base: 'Llama-3.1-8B-Instruct', name: 'Llama 3.1 8B', maker: 'Meta' },
    ],
  },
];

export interface SuggestedPick extends SuggestedModel {
  /** The Hugging Face repository to add ("mlc-ai/Llama-3.2-1B-Instruct-q4f32_1-MLC"). */
  repo: string;
  quant: string;
  /** Graphics memory the program needs, in MB (its own figure). */
  vram: number;
  /** Already one of the built-in models. */
  builtIn: boolean;
}

/**
 * The build of a suggested model for this computer: q4f16 when the graphics chip can use it, else q4f32 (which runs
 * everywhere). null when the engine has no program for either.
 */
export function pickBuild(m: SuggestedModel, halfPrecision: boolean): SuggestedPick | null {
  // A built-in model is shown as the build TOMLIN OS ships, whatever this computer could take.
  const builtIn = BUILT_IN_MODELS.find(b => b.id.startsWith(`${m.base}-`));
  const own = builtIn && MODEL_LIBS.find(l => l.base === builtIn.id);
  if (builtIn && own) return { ...m, repo: `mlc-ai/${builtIn.id}`, quant: own.quant, vram: own.vram, builtIn: true };
  for (const quant of halfPrecision ? ['q4f16_1', 'q4f32_1'] : ['q4f32_1']) {
    const id = `${m.base}-${quant}-MLC`;
    const lib = MODEL_LIBS.find(l => l.base === id);
    if (lib) return { ...m, repo: `mlc-ai/${id}`, quant, vram: lib.vram, builtIn: false };
  }
  return null;
}
