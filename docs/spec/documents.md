# Documents: reading, the register and Ask The File

How a document on a case becomes facts the engine acts on and passages anyone can search. Tests: `register-coverage.test.ts`, `file-search.test.ts`, `review.test.ts`, `draft-check.test.ts`.

## Rules

- **Every document on a case is searchable, read or not.** One the engine reads (classified and routed) has its pages indexed when its review is written. One it does not read (not recognised, below the routing confidence, a case not yet enrolled, an email) is indexed as it stands when it is filed (`indexIfUnindexed`, from the ingest hook and the upload route). Never searched: bank-details notes, our own proposals and dossiers, sandbox mail (`UNSEARCHED`).
- **Word documents are read.** The loader gives a .docx's text (mammoth) to the classifier and extractors like any text document. The old binary .doc and spreadsheets are not read; a person handles them.
- **Every reading registers its facts** (`review.ts flattenFacts`): title, contract, lease, mortgage offer, searches, replies, ID checks, management packs, and also the property forms (each TA6 / TA7 answer, on the page of its section; "not known" answers; disclosures), supporting documents (indemnity, consent, certificate: who, what it covers, limit, whether it passes on), title plans (edged red, each marking), surveys (each recommendation and legal-adviser point, with its page) and bank statements (holder, bank, period, balances; the transactions stay with proof of funds). Each fact carries the reading's confidence. A survey or statement has no page ledger: its pages are recorded unattested.
- **A quote is a fact only when it is on the page** (`verifyQuote`). A value stated without a quote is looked for itself (`findValue`): a name, reference or clause of five characters or more as written, a sum of money in pounds however printed; found, it is verified with its page. Yes/no answers and codes are not looked for, and stay unverified.
- **A person's word on a fact survives a re-read**: a confirmed or disputed fact keeps its mark when the same fact is read again.
- **Pages are chunked to keep clauses whole**: about 1,800 characters, cut at a paragraph, line or sentence end, each chunk overlapping the last by 250. PDF text keeps its lines.
- **Each chunk is embedded with its context** (`contextLine`): the file name, what the document is, the page. Questions are embedded as queries, documents as documents; a document's chunks are embedded in one batch.
- **Search is hybrid** (`findPassages`): full-text over any of the question's words (prefixes, ranked by how closely they sit) and, when an embeddings provider is set, by meaning; the two lists are fused by rank (RRF). With neither finding anything, a page holding every word as written.
- **A model judges relevance** (`file-ask.ts llmRerank`, the classify model): it orders the candidates and drops what does not help. Search works without it (and without embeddings): the fused order stands.
- **Ask The File answers in sentences, every sentence cited** (`askFile`): from the facts and passages found and nothing else; "the file does not say" when they do not answer. Each sentence must cite a source, and every figure in it must be in what it cites (`checkAnswer`); a sentence that fails shows as Not Supported, with why. The sources show under the answer, each linked to its document and page.
- **Catching up**: the first question on a case registers the facts of readings made before their kind was registered, and indexes documents filed before indexing covered them (`catchUpFileIndex`, bounded per question; no model call for the facts).
- **A replaced version is not the file**: superseded documents are excluded from search, Ask The File and the drafter's retrieval.
- **Draft check**: every engine draft's figures, dates and names are checked against the register (`draft-check.ts`); what is not on it is struck.

- **Long documents are read in sections** (`sections.ts`): a PDF over 80 pages is cut into even sections of at most 60, each read with the same instructions (three at a time), every page number moved back to the whole document's, and the readings merged: lists joined (a clause read twice kept once), the first section to state a single value wins, a yes from any section stands, the lowest confidence, the worst scan. Classifying a long scan sends only its first pages.
- **Scans are read to a time budget, not a page cap**: pages without text are OCR'd two at a time for up to 90 seconds (up to 300 pages). A page not reached is read later (`ocrCatchUp`): after a question on the case is answered, and in the background while the Tasks list is open, one document at a time; its other pages come back from the index, its quotes are checked again and it is indexed again. A page that still fails is marked tried (0%) and not tried again.
- **Tables stay tables**: PDF text is laid out from positions, a line per baseline, a wide gap between items (a column) written " | ", so a statement row reads "02/09/2026 | Salary | 2,450.00"; justified text is not split. A Word table's rows come through as cells joined by " | ".

## Measured (`npm run eval:docs`)

Ten documents a conveyancer sees on a leasehold and a freehold purchase (`tests/eval/fixtures`: official copy, lease, contract, mortgage offer, CON29 and LLC1, TA6, LPE1, indemnity, Level 3 survey, ID report), printed to PDF and read by the real pipeline and models, scored against hand-written answers (`tests/eval/expected.ts`): the kind, 61 facts, the pages key facts are cited to, and ten questions to Ask The File (one with no answer on the file). Run it after any change to a prompt, a schema, the register or search; results are kept in `tests/eval/results`.

Baseline (4 Oct 2026; no embeddings, as production): 10/10 kinds, 61/61 facts, 5/5 citation pages, quotes verified on 96–100% of quoted facts, 10/10 questions found the right document and were answered, no unsupported sentence. The run found and fixed: a fee read with VAT added, the answer check treating a house number as a claim, quotes from wrapped table cells and quotes with words left out marked unverified.

The documents are clean, typed PDFs written for the eval: real files (scans, poor copies, handwriting, odd layouts) are harder, and a set of real, anonymised files is the next measure.

## Not yet

- An embeddings provider on production (search runs on words and the relevance pass until one is set; the provider's data processing terms are an open go-live item).
