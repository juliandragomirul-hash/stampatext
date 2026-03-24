-- Add thumbnail column for storing rendered SVG preview at save time
ALTER TABLE saved_designs ADD COLUMN IF NOT EXISTS thumbnail TEXT;
