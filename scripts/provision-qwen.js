'use strict';
// Invoked only as a bounded long-worker subprocess. No credential leaves Settings.
const mongoose=require('../backend/node_modules/mongoose');
(async()=>{
 if(process.env.AUTOMATION_QWEN_ACCOUNT_SETUP!=='true'||!/^qwen(?:_|$)/i.test(process.argv[2]||''))throw Error('Account setup disabled');
 await mongoose.connect(process.env.MONGODB_URI,require('../backend/config/mongoOptions')(require('../backend/config/automationIsolation').mongoDatabase()));
 try{await require('../backend/services/qwenAutoAccount.service').ensureQwenAccount(process.argv[2]);}
 finally{await mongoose.disconnect();}
})().catch(()=>{process.exitCode=1;});
