-- ============================================
-- StampaText - Supabase Schema Setup
-- Rulează în Supabase SQL Editor (Dashboard)
-- ============================================

-- 1. ENUM TYPES
CREATE TYPE template_shape AS ENUM ('circle', 'square', 'rectangle');
CREATE TYPE template_object AS ENUM ('stamp', 'sticker', 'button', 'banner', 'blackboard', 'speech_bubble', 'speech_cloud');

-- 2. TEMPLATES TABLE
CREATE TABLE templates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  svg_path TEXT NOT NULL,
  thumbnail_path TEXT,
  width NUMERIC,
  height NUMERIC,
  shape template_shape,
  object_type template_object,
  colors TEXT[] DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. TEXT ZONES TABLE
CREATE TABLE text_zones (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  template_id UUID REFERENCES templates(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  svg_element_id TEXT,
  svg_element_index INTEGER DEFAULT 0,
  font_family TEXT,
  font_size NUMERIC,
  font_color TEXT,
  font_weight TEXT,
  stroke TEXT,
  stroke_width NUMERIC,
  text_align TEXT DEFAULT 'start',
  transform_matrix TEXT,
  bounding_width NUMERIC,
  max_length INTEGER DEFAULT 100,
  is_editable BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0
);

-- 4. GENERATIONS TABLE
CREATE TABLE generations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  template_id UUID REFERENCES templates(id),
  input_data JSONB,
  storage_path TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. CREDIT TRANSACTIONS TABLE
CREATE TABLE credit_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  reference_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

-- Templates: anyone reads active, admin full access
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read active templates" ON templates
  FOR SELECT USING (is_active = true);
CREATE POLICY "Admin full access templates" ON templates
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Text zones: anyone reads, admin full access
ALTER TABLE text_zones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read text zones" ON text_zones
  FOR SELECT USING (true);
CREATE POLICY "Admin full access text zones" ON text_zones
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Generations: user sees own only
ALTER TABLE generations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "User own generations" ON generations
  FOR ALL USING (user_id = auth.uid());

-- Credit transactions: user sees own only
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "User own transactions" ON credit_transactions
  FOR ALL USING (user_id = auth.uid());

-- ============================================
-- RPC: Atomic credit deduction
-- ============================================
CREATE OR REPLACE FUNCTION deduct_credit(
  p_user_id UUID,
  p_template_id UUID,
  p_input_data JSONB
) RETURNS void AS $$
DECLARE
  v_credits INTEGER;
  v_gen_id UUID;
BEGIN
  SELECT credits INTO v_credits FROM profiles WHERE id = p_user_id FOR UPDATE;
  IF v_credits < 1 THEN
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  UPDATE profiles SET credits = credits - 1 WHERE id = p_user_id;

  INSERT INTO generations (user_id, template_id, input_data)
  VALUES (p_user_id, p_template_id, p_input_data)
  RETURNING id INTO v_gen_id;

  INSERT INTO credit_transactions (user_id, amount, reason, reference_id)
  VALUES (p_user_id, -1, 'download', v_gen_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- TRIGGER: Auto-create profile on signup
-- (skip if already exists)
-- ============================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, email, role, credits, created_at)
  VALUES (NEW.id, NEW.email, 'user', 5, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop trigger if exists, then recreate
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
