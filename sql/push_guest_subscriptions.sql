-- Allow a browser/device to receive MJ HUB push alerts without requiring an account.
-- Existing signed-in subscriptions remain linked to their user_id.
ALTER TABLE public.push_subscriptions
  ALTER COLUMN user_id DROP NOT NULL;
