# Documents: reading, the register and Ask The File

How a document on a case becomes facts the engine acts on and passages anyone can search. Tests: `register-coverage.test.ts`, `file-search.test.ts`, `review.test.ts`, `draft-check.test.ts`.

## Rules

- **Every document on a case is searchable, read or not.** One the engine reads (classified and routed) has its pages indexed when its review is written. One it does not read (not recognised, below the routing confidence, a case not yet enrolled, an email) is indexed as it stands when it is filed (`indexIfUnindexed`, from the ingest hook and the upload route). Never searched: bank-details notes, our own proposals and dossiers, sandbox mail (`UNSEARCHED`).
- **Word documents are read.** The loader gives a .docx's text (mammoth) to the classifier and extractors like any text document. The old binary .doc and spreadsheets are not read; a person handles them.
- **Every reading registers its facts** (`review.ts flattenFacts`): title, contract, lease, mortgage offer, searches, replies, ID checks, management packs, and also the property forms (each TA6 / TA7 answer, on the page of its section; "not known" answers; disclosures), supporting documents (indemnity, consent, certificate: who, what it covers, limit, whether it passes on), title plans (edged red, each marking), surveys (each recommendation and legal-adviser point, with its page) and bank statements (holder, bank, period, balances; the transactions stay with proof of funds). Each fact carries the reading's confidence. A survey or statement has no page ledger: its pages are recorded unattested.
- **A quote is a fact only when it is on the page** (`verifyQuote`). A figure stated without a quote is unverified, and says so.
- **Pages are chunked to keep clauses whole**: about 1,800 characters, cut at a paragraph, line or sentence end, each chunk overlapping the last by 250. PDF text keeps its lines.
- **Each chunk is embedded with its context** (`contextLine`): the file name, what the document is, the page. Questions are embedded as queries, documents as documents; a document's chunks are embedded in one batch.
- **Search is hybrid** (`findPassages`): full-text over any of the question's words (prefixes, ranked by how closely they sit) and, when an embeddings provider is set, by meaning; the two lists are fused by rank (RRF). With neither finding anything, a page holding every word as written.
- **A model judges relevance** (`file-ask.ts llmRerank`, the classify model): it orders the candidates and drops what does not help. Search works without it (and without embeddings): the fused order stands.
- **Ask The File answers in sentences, every sentence cited** (`askFile`): from the facts and passages found and nothing else; "the file does not say" when they do not answer. Each sentence must cite a source, and every figure in it must be in what it cites (`checkAnswer`); a sentence that fails shows as Not Supported, with why. The sources show under the answer, each linked to its document and page.
- **Catching up**: the first question on a case registers the facts of readings made before their kind was registered, and indexes documents filed before indexing covered them (`catchUpFileIndex`, bounded per question; no model call for the facts).
- **A replaced version is not the file**: superseded documents are excluded from search, Ask The File and the drafter's retrieval.
- **Draft check**: every engine draft's figures, dates and names are checked against the register (`draft-check.ts`); what is not on it is struck.

## Not yet

- Long documents in sections (a lease over about 80 pages is read in one call); OCR past 60 pages.
- Tables kept as tables (cells are lines).
- An embeddings provider on production (search runs on words and the relevance pass until one is set; the provider's data processing terms are an open go-live item).
