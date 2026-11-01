'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {chapterNumbers,sourceUrl,validCoordinatorSecret}=require('../backend/routes/automationRoutes').__test;

test('range conversion, unique and sorted chapters',()=>{
 assert.deepEqual(chapterNumbers({startChapter:1,endChapter:3}),[1,2,3]);
 assert.deepEqual(chapterNumbers({chapters:[8,2,8,1]}),[1,2,8]);
});
test('invalid chapter requests fail',()=>{
 for (const body of [{chapters:[]},{chapters:[0]},{chapters:[true]},{chapters:[1.5]},{startChapter:1,endChapter:3000}]){
  assert.throws(()=>chapterNumbers(body));
 }
});
test('blocked sources and normalized URLs',()=>{
 assert.equal(sourceUrl('https://novelfire.net/a'),'https://novelfire.net/a');
 for(const x of ['file:///etc/passwd','http://127.0.0.1/','http://localhost/','https://person:pass@novelfire.net/a','https://novelfire.net:8443/a']){
  assert.throws(()=>sourceUrl(x));
 }
});
test('coordinator secret is opt-in and compared securely',()=>{
 const original=process.env.AUTOMATION_SECRET;
 delete process.env.AUTOMATION_SECRET;
 const req={get:()=> 'test-value'};
 assert.equal(validCoordinatorSecret(req),false);
 process.env.AUTOMATION_SECRET='test-value';
 assert.equal(validCoordinatorSecret(req),true);
 assert.equal(validCoordinatorSecret({get:()=>'other'}),false);
 if(original===undefined) delete process.env.AUTOMATION_SECRET; else process.env.AUTOMATION_SECRET=original;
});
