'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const mongoose=require('../backend/node_modules/mongoose');
const uri=process.env.AUTOMATION_TEST_REPLICA_URI;
test('private staging bootstrap is idempotent and cannot take over an existing account or a production database',{skip:!uri},async()=>{
 await mongoose.connect(uri,{dbName:'zeus_automation_admin_'+Date.now()});
 const User=require('../backend/models/user.model'),Settings=require('../backend/models/settings.model');
 await Promise.all([User,Settings].map(m=>m.init()));
 const {provision}=require('../backend/services/stagingAdmin.service');
 const env={DURABLE_ENGINE_V2:'true',AUTOMATION_STAGING_BOOTSTRAP:'true',STAGING_ADMIN_EMAIL:'Isolated@example.invalid',STAGING_ADMIN_PASSWORD:'synthetic-test-password'};
 try{
  assert.equal(await provision({...env,AUTOMATION_STAGING_BOOTSTRAP:'false'}),false);
  await assert.rejects(()=>provision({...env,STAGING_ADMIN_PASSWORD:'short'}),/credentials_required/);
  assert.equal(await provision(env),true);assert.equal(await provision(env),true);
  assert.equal(await User.countDocuments(),1);assert.equal(await Settings.countDocuments(),1);
  const user=await User.findOne();assert.equal(user.role,'admin');const original=user.password;
  await User.updateOne({_id:user._id},{$set:{role:'user'}});
  await assert.rejects(()=>provision({...env,STAGING_ADMIN_PASSWORD:'different-synthetic-password'}),/existing_account_mismatch/);
  const unchanged=await User.findById(user._id);assert.equal(unchanged.role,'user');assert.equal(unchanged.password,original);
  const express=require('../backend/node_modules/express'),app=express();app.use(express.json());
  const oldEngine=process.env.DURABLE_ENGINE_V2,oldJwt=process.env.JWT_SECRET;
  process.env.DURABLE_ENGINE_V2='true';process.env.JWT_SECRET='synthetic-signup-secret';
  require('../backend/routes/authRoutes')(app,(_req,_res,next)=>next());
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try{
   const response=await fetch('http://127.0.0.1:'+server.address().port+'/auth/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'signup-test',email:'zeuss@gmail.com',password:'syntheticPassword123'})});
   assert.equal(response.status,200);assert.equal((await response.json()).user.role,'user');
  }finally{
   await new Promise(resolve=>server.close(resolve));
   for(const [key,value] of [['DURABLE_ENGINE_V2',oldEngine],['JWT_SECRET',oldJwt]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
 }finally{await mongoose.connection.dropDatabase();await mongoose.disconnect();}
 await mongoose.connect(uri,{dbName:'non_staging_bootstrap_test_'+Date.now()});
 try{await assert.rejects(()=>provision(env),/isolated_database_required/);}
 finally{await mongoose.connection.dropDatabase();await mongoose.disconnect();}
});
