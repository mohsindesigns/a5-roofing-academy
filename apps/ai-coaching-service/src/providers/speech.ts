/**
 * Voice edges of the conversation engine. The engine is transport-agnostic: a voice transport
 * (e.g. WebSocket) uploads audio, the speech-to-text provider turns it into the rep's text, and
 * the text-to-speech provider voices the homeowner's reply. Implementations are registered with
 * the SPEECH_TO_TEXT / TEXT_TO_SPEECH tokens; none ship yet, so voice sessions are rejected with
 * a clear message until one is configured.
 */
export interface AudioInput {
  /** Reference to an uploaded clip in object storage. */
  ref: string;
  mimeType?: string;
}

export interface SpeechToTextProvider {
  readonly name: string;
  transcribe(audio: AudioInput, options: { language?: string; signal?: AbortSignal }): Promise<{ text: string; durationMs?: number }>;
}

export interface TextToSpeechProvider {
  readonly name: string;
  synthesize(
    text: string,
    options: { voice?: string; organizationId: string; sessionId: string; signal?: AbortSignal },
  ): Promise<{ audioRef: string; mimeType: string; durationMs?: number }>;
}

export const SPEECH_TO_TEXT = Symbol('SPEECH_TO_TEXT');
export const TEXT_TO_SPEECH = Symbol('TEXT_TO_SPEECH');
