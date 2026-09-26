-- OCR: when a page's text came from OCR rather than the PDF's text layer, its confidence (0–100) is kept on the ledger.
alter table document_page add column if not exists ocr_confidence int;
