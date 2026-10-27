-- Add the reasoning flag to model instances. Reasoning models require a
-- larger max_tokens on probes and return reasoning_tokens that must be
-- folded into output usage. Copied from the preset on import and settable
-- for manual entry.
ALTER TABLE model_overlays ADD COLUMN reasoning INTEGER NOT NULL DEFAULT 0;
