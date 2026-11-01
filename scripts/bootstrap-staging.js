'use strict';
const mongoose=require('../backend/node_modules/mongoose');
const User=require('../backend/models/user.model');
async function grant(email){
 if(!/^zeus_automation_/.test(User.db.name||''))throw Error('isolated_database_required');
 if(typeof email!=='string'||email.length>254||!/^\S+@\S+\.\S+$/.test(email))throw Error('invalid_staging_email');
 const user=await User.findOneAndUpdate({email:email.trim().toLowerCase()},{$set:{role:'admin'}},{new:true,runValidators:true});
 if(!user)throw Error('register_staging_account_first');
 return {id:user.id,role:user.role};
}
if(require.main===module)(async()=>{
 if(process.env.ZEUS_BOOTSTRAP_STAGING!=='true')throw Error('bootstrap_not_enabled');
 await mongoose.connect(process.env.MONGODB_URI,require('../backend/config/mongoOptions')(require('../backend/config/automationIsolation').mongoDatabase()));
 try{await grant(process.env.STAGING_ADMIN_EMAIL);console.log('Existing isolated staging account granted admin role.');}
 finally{await mongoose.disconnect();}
})().catch(()=>{console.error('Staging bootstrap refused; verify isolated database and existing account.');process.exitCode=1;});
module.exports={grant};
