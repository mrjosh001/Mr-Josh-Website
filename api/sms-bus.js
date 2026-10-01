import { createClient } from '@supabase/supabase-js';
export default function handler(req,res){res.status(503).json({success:false,message:'sms-bus restore in progress - reupload full file'});}
