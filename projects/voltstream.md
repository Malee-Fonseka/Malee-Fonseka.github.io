---
title: voltstream — Smart Grid Billing Pipeline
parent: Projects
nav_order: 4
description: A Lambda-architecture data pipeline that computes smart grid electricity billing from meter data.
published: false # delete this line once every TODO placeholder below is resolved
---

# voltstream — Smart Grid Billing Pipeline
{: .no_toc }

A data engineering pipeline that turns smart meter readings into electricity bills, built on the Lambda architecture: a batch layer for accurate billing over the full history and a speed layer for near-real-time consumption views.
{: .fs-5 .fw-300 }

| | |
|---|---|
| **Type** | Big Data Analytics coursework |
| **My role** | [TODO: What you owned] |
| **Stack** | [TODO: Ingestion, batch, stream, storage and serving technologies] |
| **Period** | [TODO: Month Year – Month Year] |
| **Source** | [TODO: Repository link] |

<details open markdown="block">
  <summary>Contents</summary>
  {: .text-delta }
- TOC
{:toc}
</details>

## Problem

Billing must be exact and reproducible, which favours batch processing over the complete dataset. Customers and grid operators also want to see consumption as it happens, which needs streaming. The Lambda architecture runs both paths side by side and merges their results at query time.

## Architecture

[TODO: Name the technology used in each layer.]

```mermaid
flowchart LR
    M[Smart meters] --> I[Ingestion]
    I --> BL[Batch layer: complete history]
    I --> SL[Speed layer: recent readings]
    BL --> BV[Batch views: accurate bills]
    SL --> RV[Real-time views: live usage]
    BV --> Q[Serving layer]
    RV --> Q
```

## Key decisions

### Lambda rather than Kappa

[TODO: Why you kept a separate batch path instead of a single streaming pipeline, and what the duplication cost you.]

### Late and out-of-order readings

[TODO: How the speed layer handles meters that report late, and how the batch layer corrects it.]

### Tariff calculation

[TODO: Where tariff logic lives and how you kept it identical in both layers.]

## Results

[TODO: Data volume processed, batch run time, streaming latency.]

## What I'd change

[TODO: Lessons learned.]
