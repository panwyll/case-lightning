-- Document template library: firm-uploaded .docx files with {{var}} and [[LLM prompt]] placeholders.
-- Tenants upload their own letter/document templates; the app fills them from matter data on demand.

CREATE TABLE doc_template (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name              TEXT        NOT NULL,
  description       TEXT,
  file_name         TEXT        NOT NULL,
  file_content      BYTEA       NOT NULL,
  file_size_bytes   INT         NOT NULL,
  -- True when the template contains [[...]] LLM-prompt blocks (premium feature flag).
  has_llm_prompts   BOOLEAN     NOT NULL DEFAULT FALSE,
  sort_order        INT         NOT NULL DEFAULT 0,
  created_by        UUID        REFERENCES app_user(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX doc_template_tenant_idx ON doc_template(tenant_id, sort_order);
