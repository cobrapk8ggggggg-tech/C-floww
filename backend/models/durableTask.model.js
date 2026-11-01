'use strict';
const m=require('mongoose');
const schema=new m.Schema({
 jobId:{type:m.Schema.Types.ObjectId,required:true,index:true},number:{type:Number,required:true},ordinal:{type:Number,required:true},
 stage:{type:String,default:'source'},unit:{type:Number,default:0},units:{type:Number,default:0},
 repair:{type:Number,default:0},extractionUnit:{type:Number,default:0},
 state:{type:String,enum:['pending','verified','blocked','failed'],default:'pending'},
 code:{type:String,default:''},sourceHash:String,glossaryRef:String,
 generation:{type:Number,default:0},publicationId:String,
},{timestamps:true,versionKey:false});
schema.index({jobId:1,number:1},{unique:true});
schema.index({jobId:1,ordinal:1},{unique:true});
module.exports=m.models.DurableTask||m.model('DurableTask',schema);
