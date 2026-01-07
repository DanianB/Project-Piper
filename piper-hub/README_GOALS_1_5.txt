Piper Hub - Goals 1-5 Bundle (Jan 7 2026)

This zip contains ONLY the updated files. Copy them into your repo, preserving paths.

Included:
- piper-hub/src/services/mind.js
- piper-hub/src/routes/chat.js
- piper-hub/src/services/chatterbox_manager.js
- piper-hub/src/services/voice/tts.js
- piper-hub/src/routes/voice.js
- piper-hub/public/index.html

Features:
1) Chatterbox TTS pre-warm (opt-in)
   - Set env: CHATTERBOX_PREWARM=1
   - On first successful /health, Piper sends a tiny /audio/speech to warm the model & CUDA.

2) Emotion -> prosody tuning (subtle) + mood modulation
   - Client now sends mood to /voice/speak
   - tts.js uses mood to slightly adjust exaggeration/temperature/cfg_weight.

3) Session summaries / working memory compression (no extra LLM calls)
   - mind.js maintains up to 5 bullet 'sessionSummary' refreshed every N turns
   - Set env: PIPER_SUMMARY_EVERY_N_TURNS=6 (default 6)

4) Long-term opinion shaping (reinforcement)
   - mind.js persists userTaste likes/dislikes; influences future opinion adjustments gently (not guaranteed agreement)
   - Clear statements like 'I love X' and 'X is my favorite' are recorded, but trivial rituals are ignored.

5) Last-topic resolution
   - If message is vague ('I don't like it', 'that one', etc.), Piper assumes the last meaningful topic and adds an internal hint to the LLM prompt.

Notes:
- mind.json schema version bumped to 2; existing file is migrated in-place (adds userTaste).
