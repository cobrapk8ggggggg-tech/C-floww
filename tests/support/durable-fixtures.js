'use strict';
function fakeFirestore(){
 const docs=new Map();
 return {docs,collection:()=>({doc:novel=>({collection:()=>({doc:number=>{const key=novel+':'+number;return {key,get:async()=>({exists:docs.has(key),data:()=>docs.get(key)})};}})})}),
 runTransaction:async fn=>fn({get:ref=>ref.get(),set:(ref,data)=>docs.set(ref.key,{...docs.get(ref.key),...data})})};
}
module.exports={fakeFirestore};
