# probascope

I want to shove AI into the device and look inside it, because I believe the future is in
models we can see into, ideally on device. This is the looking-inside part, on a phone.

probascope runs a Jev-like decision model natively on your Android phone, through
[kneejerk](https://github.com/moudrkat/kneejerk) (llama.cpp inside the app, no server). You
paste a text, ask one question, and get calibrated probabilities in a few hundred
milliseconds. Then you drag your finger over the layers and see where in the model the
answer formed, and tap the blocks your text went through. The model never leaves the phone.

A decision model does not write. It reads a *state* and typed *questions* and returns
probabilities in one forward pass. TypeSafe made the format (Jev, `/v1/systemone`), Liquid AI
released open ones (d1), llama.cpp runs them. Nobody had looked inside one on a phone.

## Install

Android only for now. The APK is about 30 MB; the models download inside the app.

1. On the phone, open the [releases page](https://github.com/moudrkat/probascope/releases)
   and tap `probascope.apk`.
2. Android asks to allow installs from this source (your browser). Allow it, then install.
3. Open probascope, pick a model. **d1-omni 600M** (407 MB) is the quick first one,
   **d1 2B** (1.1 GB, about 2 GB of RAM while loaded) is the one worth comparing against.
4. Write a text and a question, add two or more options (or none for a yes/no), tap **decide**.

Measured on a Pixel 8a: d1 2B answers in about 0.5 s.

## What you see

- **answer**: the probability of each option, and the time it took.
- **layers**: the answer each layer would give, read through the model's own output head
  (a logit lens). Drag to replay the bars at any layer. Early layers can mislead, the head was
  trained on the last one.
- **inside**: the blocks your text went through, from the GGUF on your phone, not from a
  paper: short convolutions, attention, and the trailing blocks trained as the decision head.
  Tap a block for what it does and its sizes.

Laya reads its answer from a pooled embedding, so it has no layer curve yet.

## Build it yourself

Node 22, Android SDK with NDK 27 and cmake, a JDK 21.

```bash
git clone --recurse-submodules https://github.com/moudrkat/kneejerk
git clone https://github.com/moudrkat/probascope
cd probascope && npm install && npm run build && npx cap sync android
cd android && ./gradlew assembleDebug      # app/build/outputs/apk/debug/app-debug.apk
```

The plugin is `kneejerk/bindings/capacitor`, linked as a `file:` dependency; the Gradle build
cross-compiles llama.cpp for arm64 into the APK.

## Not yet

iOS (the library builds for it, the Swift binding does not exist), images and audio as the
state (d1-omni can, the library cannot yet), a curve for pooled-embedding models, comparing the
same question across models side by side, attention to the words of the state.
