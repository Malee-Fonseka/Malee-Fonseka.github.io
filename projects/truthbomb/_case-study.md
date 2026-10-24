---
# ============================================================================
# PROJECT CASE STUDY (MARKDOWN)
# ============================================================================
# Edit the case study here, then ask Claude to
# "generate projects/truthbomb/index.html from _case-study.md".
# The guide to the extra blocks is in projects/_template/_case-study.md.
# ============================================================================

# ---- page header -----------------------------------------------------------
title: TruthBomb
kicker: Case study · University group project, AI module
description: >
  A multi-agent fact-checker that reads Sri Lankan social media posts in Sinhala, Tamil,
  English and Singlish and checks them against trusted local news.
summary: >
  TruthBomb takes a social media post written the way Sri Lankans actually write, in Sinhala,
  Tamil, English or a mix typed in Latin script, and returns a verdict with its evidence,
  explained in three languages. A fine-tuned 3.8B-parameter model on a consumer GPU turns the
  post into one clean English claim. A LangGraph pipeline then gathers evidence, decides by
  score whether local sources are enough, and settles the verdict with explicit rules, calling
  a cloud model only when the evidence is unclear.
tech:
  key: [LangGraph, Phi-3.5-mini (fine-tuned), llama.cpp]
  other: [Unsloth + LoRA, ChromaDB, BM25, Gemini API, FastAPI, React, TypeScript, Tesseract.js, Telethon]
links:
  - text: source code
    url: https://github.com/GiharaNavindu/TruthBomb
    primary: true

# ---- card on projects.html ---------------------------------------------------
card:
  year: 2026
  status: complete
  description: >
    A fact-checker for code-mixed Sri Lankan social media. A local fine-tuned model reads
    the post, and rules rather than prompts decide the verdict, so every answer can be traced.
  area: ai
  tech:
    key: [LangGraph, Phi-3.5 GGUF]
    other: [ChromaDB, Gemini, FastAPI, React]
---

## Overview

TruthBomb is an automated fact-checker for Sri Lankan social media. You paste a post (or a
screenshot of one) and it extracts the single claim the post is making, looks for evidence in a
live archive of news alerts and on trusted news sites, and returns one of four verdicts: True,
False, Misleading or Unverified. Each verdict comes with the evidence used, a short explanation
in English, Sinhala and Tamil, and a record of every step that led to it.

We built it as a four-person university team. The first version worked end to end, but its
decisions were made inside prompts and could not be explained or reproduced. Most of this case
study is about the rebuild that fixed that: the same models, rearranged so that code makes the
decisions and models only do the work that needs a model.

::: metrics
- **4** input languages, including code-mixed Singlish
- **2.3 GB** quantized model that runs extraction and local verification on one consumer GPU
- **125** benchmark posts: 25 news events, each written five different ways
- **6** pipeline steps, each one logged to an audit trail
:::

::: note "my part"
Teammates built the first fine-tuned extractor and the original multi-agent version, a
retrieval overhaul with evaluation scripts, and in-browser OCR. I led the five-phase redesign
described under *How the design evolved*: one canonical pipeline, grammar-constrained
extraction, a dedicated retrieval step, score-based routing and rules-first adjudication.
:::

## The problem {#problem}

False claims about arrests, road accidents, floods, gazette notices and exam results spread on
Sri Lankan social media faster than newsrooms can correct them. Checking one by hand means
working out what the post actually claims, finding a credible report of the same event, and
judging whether the two agree. That is slow, and most posts are not written in a form that
standard tools can work with.

The language is the first obstacle. A typical post looks like this:

> *Train eka derail kara Galle station ta! 😱 5 ta people injured kiyala news dakka! Track eka
> problem nada enna railway ta?*

That is Sinhala grammar typed phonetically in Latin letters, mixed with English words, emoji and
a rhetorical question. Search engines and fact-checking models trained on clean English text
struggle with it. Posts in Sinhala or Tamil script, or in formal English, need to work just as
well.

Timing is the second obstacle. Breaking news reaches the official Telegram channels of Sri Lankan
news outlets well before articles are written and indexed by search engines, so a checker that
only searches the web misses the newest events, which are the ones most likely to be rumours.

Trust is the third. A bare "False" from a model gives a reader no reason to believe it. A useful
answer has to show which sources it relied on, how it weighed them, and has to say so in the
reader's own language.

::: note "about Singlish"
In Sri Lanka, "Singlish" means Sinhala written in the Latin alphabet and mixed with English.
It is not the Singaporean creole of the same name. Tamil speakers mix languages in the same way
("Tanglish").
:::

## Requirements {#requirements}

From those problems we set out what the system had to do, and the conditions it had to work
under.

| requirement | how TruthBomb meets it |
| --- | --- |
| Read posts in English, Sinhala, Tamil and Singlish, typed or as a screenshot | A fine-tuned extractor normalizes any of the four into one English claim. Screenshots are read by OCR in the browser with English, Sinhala and Tamil language models. |
| Ground every verdict in evidence from trusted sources | Local evidence comes from news outlets' Telegram channels. Web search is restricted to ten trusted news domains, and untrusted sources are down-weighted in ranking. |
| Cover breaking news | A separate worker polls the Telegram channels every 60 seconds and skips messages it has already stored. |
| Return one of four verdicts: True, False, Misleading, Unverified | A single canonical vocabulary, assigned by a rules-first adjudicator. |
| Explain the verdict in English, Sinhala and Tamil | A translation step writes a two-sentence summary in each language. |
| Run on a consumer GPU | The extractor is a 4-bit GGUF model (2.3 GB). One loaded copy serves both extraction and local verification. |
| Be reproducible and auditable | Temperature 0 everywhere, grammar- or schema-constrained model output, threshold-based routing and adjudication, and a per-step audit trail returned with every response. |
| Degrade instead of failing | Every step has a defined fallback, and the fallback is recorded in the audit trail. |
| Keep cloud calls few | The cloud model (Gemini) is used only for web verification, unclear verdicts and translation. |

## Architecture

The system has three parts. A **browser app** collects the post. A **FastAPI service** runs the
fact-checking pipeline, which is a LangGraph state graph. A separate **ingestion worker** keeps
the local evidence store up to date. The API is deliberately thin: it validates the request,
runs the graph off the event loop and maps the graph's final state onto the response. Every
decision happens inside the graph.

![Architecture diagram. A browser sends post text to a FastAPI service, which runs a LangGraph pipeline of six steps: extract, retrieve, a score check that routes to either a local or a web verifier, adjudicate and translate. Extract and the local verifier run on a local fine-tuned Phi-3.5 model; the web verifier and translate call Gemini; retrieve, the score check and adjudicate are plain code. Below the graph, a Telegram ingest worker feeds ChromaDB, which retrieve reads, and DuckDuckGo search over ten trusted domains feeds the web verifier.](images/architecture.svg){pad}
*One request through the system. Colour shows where each step runs: teal on the local GPU,
amber on the Gemini API, plain boxes are ordinary code. The verdict travels back to the browser
with the trilingual summary and the audit trail.*

All the steps share one state object: the raw post, its language, the extracted claim, the
retrieved documents with their scores, each verifier's output, the final verdict and the audit
trail. A step reads what it needs and writes only its own fields. The audit trail is the one
field that is merged rather than overwritten, so each step appends a line saying what it did
and whether it succeeded.

::: decision
- **context:** The first version had two verification paths. The API ran its own
  extract, search and judge sequence, and the LangGraph pipeline did something similar with
  different retrieval. The same post could get different verdicts depending on which path ran,
  and the Telegram worker, with hard-coded credentials, ran inside the API process.
- **decision:** Make the graph the only pipeline. The API became a transport layer, the
  ingestion worker became a standalone process, and all credentials moved to environment
  variables.
- **trade-off:** There is now one place to reason about, test and log. The cost was losing the
  API's shortcut path, so every request pays for the full graph.
:::

## How it works {#implementation}

::: flow
1. **Extract** post → one English claim and its language
2. **Retrieve** keyword and semantic search, fused and re-ranked
3. **Route** is the local evidence strong enough?
4. **Verify** stance and confidence, from local or web evidence
5. **Decide** rules first; a model only when the evidence is unclear {key}
:::
*The request path. Steps 1 and 4 use models; steps 2, 3 and 5 are deterministic code, which is
what makes a verdict traceable.*

### Reading the post: a fine-tuned extractor

The first step turns a noisy post into a claim that search can work with. We fine-tuned
**Phi-3.5-mini-instruct** (3.8B parameters) with **Unsloth** and **LoRA** on Google Colab,
using 4-bit training and Alpaca-style prompts. The training set has 425 examples, each a post in
Sinhala, Singlish or code-mixed English paired with the plain English claim it makes:

| post | target claim |
| --- | --- |
| *Train eka derail kara Galle station ta! 😱 5 ta people injured kiyala news dakka!* | Train derailed near Galle station; 5 passengers injured. |
| *mchn parliament eka krook full nada! MP eka bank fraud kara gana! 😤 Airport ta catch kara arrest kiyapala!* | Parliamentary member arrested for banking fraud at airport. |
| *Landslide warning! 😱 Central highlands ta evacuate kara labala inna!* | Landslide evacuation ordered for central highlands due to heavy rainfall. |

The adapters were merged into the base model and exported as a 4-bit **GGUF** file (Q4_K_M,
2.3 GB), which **llama.cpp** runs with every layer on the GPU. At inference time the model runs
at temperature 0 under a **GBNF grammar**, a formal grammar applied while tokens are generated,
so the only output it can produce is `{"language": …, "extracted_claim": …}` with the language
limited to four values. It cannot answer with prose, markdown or broken JSON, so nothing
downstream has to clean up its output.

### Finding evidence: hybrid retrieval

Retrieval combines two searches over the local store, because each misses things the other
finds:

- **Semantic search** in ChromaDB, using the multilingual `paraphrase-multilingual-MiniLM-L12-v2`
  embedding model, so a claim derived from a Sinhala post can match an English news alert about
  the same event.
- **Keyword search** with BM25, which catches exact names, places, numbers and acronyms that
  embeddings tend to blur.

An early version merged the two lists by hand and gave every BM25 hit a flat score of 1.0,
which put dense distances and keyword ranks on incompatible scales. We replaced that with
**Reciprocal Rank Fusion** (RRF, k = 60), which only looks at rank positions. The fused list is
then re-weighted by **source tier** (trusted sources × 1.0, others × 0.6) and **recency** (from
× 1.0 for the last week down to × 0.35 for anything over a year old), and the top four are kept.
Every component score is stored with the document, so the interface can show why a source ranked
where it did.

In parallel, a teammate's retrieval overhaul added an optional cross-encoder re-ranker and an
offline evaluation that reports Recall@5, MRR and nDCG@5 using the benchmark's event IDs as
ground truth. That meant changes to retrieval could be measured instead of judged by eye.

### Choosing where to verify: score-based routing

The router takes the best semantic match from retrieval, expressed as a similarity between 0 and
1. If it reaches **0.4**, the local archive has something close enough to check against, and the
claim goes to the local verifier. If it does not, the claim goes to web search.

::: decision
- **context:** Version one asked Gemini to label each claim "local" or "web" before any evidence
  had been retrieved. The label was a guess about where evidence might be, it couldn't be
  reproduced, and when the call failed everything was quietly sent to web search.
- **decision:** Retrieve first, then route on the measured strength of the best local match
  against a fixed threshold.
- **trade-off:** Routing is now deterministic, free and testable. But similarity is not the same
  as relevance: a close match about a different event can pass the threshold, and 0.4 is a
  starting default that still needs calibrating against the benchmark.
:::

### Verifying: one contract, two verifiers

Both verifiers return the same shape: a **stance** (SUPPORTED, REFUTED or INSUFFICIENT), a
**confidence** from 0 to 100 and a one-sentence reason. A stance is a verdict on the evidence,
not on the claim. Turning stances into a final answer is a separate step.

- The **local verifier** reuses the GGUF model that is already loaded for extraction, so only one
  copy sits in VRAM. A second grammar limits its output to the stance shape. If retrieval found
  nothing, it returns INSUFFICIENT without calling the model at all.
- The **web verifier** searches DuckDuckGo with `site:` filters for ten trusted Sri Lankan news
  and government domains, then asks Gemini 2.5 Flash-Lite, in JSON-schema mode at temperature 0,
  for the same stance shape plus the sources it used. If the restricted search fails, it falls
  back to an open search but labels those results UNRESTRICTED, and the prompt tells the model
  to demand official corroboration for them.

```gbnf title="src/tools/local_verifier.py" label="gbnf · excerpt"
root   ::= "{" ws "\"stance\"" ws ":" ws stance ws "," ws "\"confidence\"" ws ":" ws number ws "," ws "\"reasoning\"" ws ":" ws string ws "}"
stance ::= "\"SUPPORTED\"" | "\"REFUTED\"" | "\"INSUFFICIENT\""
number ::= digit ( digit ( digit )? )?
```

Because both verifiers keep to this contract, the next step does not need to know where the
evidence came from.

### Deciding: rules first, model second

The adjudicator maps stances onto the four verdicts. Clear cases are decided by fixed rules;
Gemini is called only for borderline confidence or conflicting evidence.

| evidence | confidence | verdict | decided by |
| --- | --- | --- | --- |
| one side (supported or refuted) | 70 or more | True or False | rules |
| one side | 40 to 69 | any of the four | Gemini |
| one side | below 40 | Unverified | rules |
| both supported and refuted | any | any of the four | Gemini |
| only insufficient, or none | — | Unverified | rules |

"Misleading" can only come from the Gemini path. That is intentional: deciding that a claim is
partly true or deceptively framed takes judgement that a threshold cannot supply. Each verdict
records which path produced it (`rules` or `gemini`). If Gemini fails on a borderline case, the
verdict falls back to the direction of the stance; if it fails on a conflict, the verdict is
Unverified.

::: decision
- **context:** In version one a single free-form Gemini prompt chose the verdict, the confidence
  and the translations all at once, and the code parsed its reply by stripping markdown fences
  and hoping the rest was JSON.
- **decision:** Split that into a structured verification step, a rules-first adjudicator and a
  separate translator.
- **trade-off:** Clear-cut verdicts are now reproducible and cost no API call, and every verdict
  says how it was reached. The thresholds (40 and 70) are design choices that have to be
  defended and calibrated rather than left to a model.
:::

### Explaining: translation and the audit trail

The translator asks Gemini, in JSON-schema mode, for a two-sentence summary of the verdict in
English, Sinhala and Tamil. It is best effort by design: if it fails, the response carries an
English-only summary and the audit trail records the failure, so a translation problem never
blocks a verdict.

The audit trail is what the whole redesign was aiming at. Every step appends a status and a short
detail, such as which model extracted the claim and in what language, how many documents were
retrieved and how strong the best match was, which verifier ran and what stance it returned, and
whether the verdict came from rules or from Gemini. The API returns the trail with the verdict,
so anyone can see how an answer was reached.

### Keeping the evidence fresh

The ingestion worker connects to Telegram over MTProto using Telethon and polls the channels of
Ada Derana, News 1st and Hiru News. Each message is stored with its source, message ID and
timestamp, and IDs already in the store are skipped. Running it as its own process means a
Telegram outage or a login prompt never holds up a fact-check request.

### The interface

The front end is a React and TypeScript app built with Vite, Tailwind and shadcn/ui. Users can
paste text or upload a screenshot. **Tesseract.js** reads the screenshot in the browser using its
English, Sinhala and Tamil models, so the image never leaves the device. The result card
colour-codes the verdict, shows a confidence bar, switches between the three language summaries
on tabs, and lists each piece of evidence with its source tier, timestamp and scores.

## How the design evolved {#evolution}

::: flow
1. **Traffic-law prototype** Phi-3.5 + RAG over Sri Lanka's motor traffic law
2. **General fact-checker** LLM triage, two researchers, one synthesis prompt
3. **Phased redesign** one change per phase, each fixing a known failure {key}
:::
*TruthBomb started as a single-domain experiment and was generalized before it was made
dependable.*

The project began as a fine-tuned model that checked claims about traffic law against the Motor
Traffic Act. Generalizing it to any news topic produced a working multi-agent system: an LLM
triage agent, a local and a web researcher, and a synthesis agent that wrote the verdict. It
demonstrated well, but it was hard to trust. Results could change between runs, failures were
silent, and no one could say why a given verdict came out the way it did.

We rebuilt it in five phases. Each phase changed one thing and was tested before the next began:

| phase | change | problem it fixed |
| --- | --- | --- |
| 1 | LangGraph becomes the only pipeline; API made thin; ingestion moved to its own process | Two verification paths that could disagree; credentials in source code |
| 2 | Grammar-constrained extraction at temperature 0; routing taken out of the extractor | Free-text output that needed cleaning up; routing guessed before any evidence existed |
| 3 | A dedicated retrieval step with fusion and tier and recency re-ranking | Retrieval hidden inside a tool, with no scores visible to the rest of the graph |
| 4 | Score-based routing; both verifiers emit the same stance contract | Prose findings that nothing downstream could reason about |
| 5 | Rules-first adjudication, separate translator, audit trail, widened response schema | One free-form prompt deciding everything; no Misleading verdict in the API; no trace |

## Results

TruthBomb runs end to end on a laptop with a consumer GPU and a Gemini API key. It takes a post
or a screenshot in any of the four input languages and returns a verdict with its evidence, a
trilingual explanation and a step-by-step audit trail.

The project includes its own evaluation:

- **A 125-post benchmark**: 25 news events across 11 categories, including arrests, accidents,
  weather alerts, court rulings, gazette notices, strikes and exam results. Each event is written
  in five styles: formal Sinhala, two informal Singlish variants and two code-mixed variants.
- **An accuracy run** that sends every post through the live API and reports per-class precision
  and recall and a weighted F1 score.
- **A retrieval evaluation** that reports Recall@5, MRR and nDCG@5, using the benchmark's event
  IDs as ground truth, so retrieval can be measured without hand labelling.
- **Unit tests** for rank fusion, which run without models or a database.

::: note "still open"
The routing threshold (0.4) and the adjudication bands (40 and 70) are documented starting
defaults. They have not yet been calibrated against the benchmark. That is the next piece of work,
and it is far easier now that each decision is a number in one config file instead of wording in
a prompt. The benchmark also has a known flaw: its posts are part of the extractor's training
data, so it measures retrieval and verification fairly but flatters extraction. A held-out set of
new posts is needed before any extraction score can be trusted.
:::

<!--
  Add when available:
  - weighted F1 from evaluation/benchmark_accuracy.py and Recall@5 / MRR / nDCG@5 from
    evaluation/eval_retrieval.py (consider swapping them into the metrics row above)
  - screenshots of the result card (verdict, language tabs) and the evidence list, e.g.

::: gallery
![The result card showing a verdict badge, a confidence bar and English, Sinhala and Tamil summary tabs](images/result-card.png)
*Verdict, confidence and the trilingual summary.*

![The evidence list showing each retrieved source with its tier, timestamp and scores](images/evidence.png)
*The evidence behind the verdict, with the scores that ranked it.*
:::
-->

## What I learned {#lessons}

- **Put the decisions you need to explain in code, not in prompts.** Routing and adjudication
  went from "the model said so" to a threshold you can read, test and change. The models still
  do the language work, which is what they are good at.
- **Constrain model output while it is generated, not afterwards.** Grammars for the local model
  and JSON schemas for Gemini removed a whole class of failures where the model replied in
  markdown or prose, along with the code that tried to clean that up.
- **A shared contract makes components interchangeable.** Once both verifiers returned the same
  stance shape, the adjudicator could be simple rules, and adding a third evidence source would
  not change it.
- **Design the failure path for every step.** Each node has a defined fallback and logs it, so a
  translation outage produces an English-only answer instead of an error page.
- **Next time, agree the target architecture before branching.** We built two retrieval
  implementations in parallel on separate branches, and later merges brought back pieces the
  redesign had removed. Next time I would write down the architecture and the interfaces between
  steps first, then split the work.
- **Keep test data out of training data from the first day.** Our benchmark posts were reused
  as fine-tuning examples, which means the benchmark cannot measure the extractor honestly. I
  would split off a held-out set before generating any training data.
- **Calibrate before you add features.** I would run the benchmark and tune the thresholds
  before anything else. I would also update the keyword index incrementally: at the moment new
  Telegram posts appear in semantic search straight away but only reach BM25 after a restart.
