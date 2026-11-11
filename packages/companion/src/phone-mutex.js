export function createPhoneMutex(){
 let busy=false;const queue=[];
 const release=()=>{const next=queue.shift();if(next)next();else busy=false};
 return {
  async runUser(fn){if(busy)await new Promise(resolve=>queue.push(resolve));else busy=true;try{return await fn()}finally{release()}},
  async tryBackground(fn){if(busy||queue.length)return false;busy=true;try{await fn();return true}finally{release()}}
 };
}
export const phoneMutex=createPhoneMutex();
