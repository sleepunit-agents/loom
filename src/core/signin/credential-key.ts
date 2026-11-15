/** Read the COSE credential key embedded in WebAuthn registration data.
 * The accepted subset is bounded definite-length maps, integers and bytes.
 * Extensions after the key are not part of the public key.
 */
import {createPublicKey,timingSafeEqual} from 'node:crypto';
export function credentialKey(data:Buffer,provided:string){
 if(data.length<55)throw Error('Credential data missing');
 let offset=55+data.readUInt16BE(53),depth=0;
 const read=():number|Buffer|Map<number,unknown>=>{
  if(++depth>4||offset>=data.length)throw Error('Invalid credential key');
  try{
   const byte=data[offset++],major=byte>>5,info=byte&31;
   let size=info;
   if(info===24){if(offset>=data.length)throw Error('Truncated key');size=data[offset++];}
   else if(info===25){if(offset+2>data.length)throw Error('Truncated key');size=data.readUInt16BE(offset);offset+=2;}
   else if(info>=26)throw Error('Unsupported credential key');
   if(major===0)return size;if(major===1)return -1-size;
   if(major===2){if(size>4096||offset+size>data.length)throw Error('Truncated key');const value=data.subarray(offset,offset+size);offset+=size;return value;}
   if(major===5){if(size>16)throw Error('Key too large');const result=new Map<number,unknown>();for(let n=0;n<size;n++){const key=read();if(typeof key!=='number'||result.has(key))throw Error('Invalid key map');result.set(key,read());}return result;}
   throw Error('Unsupported credential key');
  }finally{depth--;}
 };
 const key=read();if(!(key instanceof Map))throw Error('Credential key must be COSE');
 const bytes=(id:number,length?:number)=>{const value=key.get(id);if(!Buffer.isBuffer(value)||!value.length||(length!==undefined&&value.length!==length))throw Error('Invalid key coordinate');return value.toString('base64url');};
 const alg=key.get(3),kty=key.get(1);
 const jwk=kty===2&&alg===-7&&key.get(-1)===1?{kty:'EC',crv:'P-256',x:bytes(-2,32),y:bytes(-3,32)}
  :kty===1&&alg===-8&&key.get(-1)===6?{kty:'OKP',crv:'Ed25519',x:bytes(-2,32)}
  :kty===3&&alg===-257?{kty:'RSA',n:bytes(-1),e:bytes(-2)}:undefined;
 if(!jwk)throw Error('Unsupported credential key');
 const actual=createPublicKey({key:jwk,format:'jwk'}).export({type:'spki',format:'der'}),expected=Buffer.from(provided,'base64url');
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('Credential public key mismatch');
 return alg;
}
