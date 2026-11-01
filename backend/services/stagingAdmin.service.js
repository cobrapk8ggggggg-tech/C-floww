'use strict';
const crypto=require('node:crypto');
const User=require('../models/user.model');
const Settings=require('../models/settings.model');
let pending;
async function provision(env=process.env){
 if(env.DURABLE_ENGINE_V2!=='true'||env.AUTOMATION_STAGING_BOOTSTRAP!=='true')return false;
 if(!/^zeus_automation_/.test(User.db.name||''))throw Error('isolated_database_required');
 const email=String(env.STAGING_ADMIN_EMAIL||'').trim().toLowerCase(),password=env.STAGING_ADMIN_PASSWORD;
 if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254||typeof password!=='string'||password.length<12||password.length>256)throw Error('staging_admin_credentials_required');
 const hash=crypto.createHash('sha256').update(password).digest('hex');
 const user=await User.findOneAndUpdate({email},{$setOnInsert:{googleId:'staging_'+crypto.randomUUID(),email,
  name:'staging-admin-'+crypto.createHash('sha256').update(email).digest('hex').slice(0,12),password:hash,role:'user'}},{upsert:true,new:true,setDefaultsOnInsert:true,runValidators:true});
 // An existing account must prove the same password; never overwrite its credentials.
 const granted=await User.findOneAndUpdate({_id:user._id,password:hash},{$set:{role:'admin'}},{new:true});
 if(!granted)throw Error('staging_admin_existing_account_mismatch');
 await Settings.findOneAndUpdate({user:granted._id},{$setOnInsert:{user:granted._id}},{upsert:true,setDefaultsOnInsert:true});
 return true;
}
async function ensure(){
 if(!pending)pending=provision().catch(error=>{pending=null;throw error;});
 return pending;
}
module.exports={provision,ensure};
