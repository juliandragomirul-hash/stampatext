-- Saved designs table for user combo bookmarking
CREATE TABLE IF NOT EXISTS saved_designs (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  params TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS: users see only their own saves
ALTER TABLE saved_designs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own saves"
  ON saved_designs FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Index for fast lookup by user
CREATE INDEX IF NOT EXISTS idx_saved_designs_user
  ON saved_designs(user_id, created_at DESC);
