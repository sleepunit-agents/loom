import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Existing renderer lacks declarations.
import { act, create } from 'react-test-renderer';
import { ValueControl, RequestControl, RevokeControl, DefaultControl, RuleControl } from './controls';
vi.mock('../attention/home-composer',()=>({HomeMessageComposer:(props:{suggestedText:string})=>h('textarea',{value:props.suggestedText,readOnly:true})}));
const requestedInput=()=>JSON.parse(tree.root.findByType('textarea').props.value.split('\n').slice(1).join('\n'));
vi.mock('../../data/graphql',()=>({useDataQuery:()=>({status:'live',data:{homeComms:{member:'alex',agents:['fern']},householdSetup:{defaultAgent:'fern'}}})}));
vi.mock('../../kit',()=>({Button:(p:any)=>h('button',p),Input:(p:any)=>h('input',p)}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:any;
afterEach(async()=>{await act(async()=>tree?.unmount());tree=undefined;vi.unstubAllGlobals();});
const payloads:unknown[]=[];
function transport(before?:()=>void){payloads.length=0;const request=vi.fn(async(url:string,init:RequestInit)=>{before?.();expect(url).toMatch(/^\/api\/secrets\/(command|set|remove)$/);expect(init.method).toBe('POST');expect(init.credentials).toBe('same-origin');expect(init.headers).toEqual({'content-type':'application/json'});const body=JSON.parse(String(init.body));expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);payloads.push({url,input:body.input});return Response.json({ok:true,value:{saved:true}});});vi.stubGlobal('fetch',request);return request;}
async function draw(component:any,props:object={},node?:object){await act(async()=>{tree=create(h(component,props),{createNodeMock:(element:any)=>element.type==='input'&&element.props.type==='password'?node:null});});}
async function click(label:string){const button=tree.root.findAllByType('button').find((value:any)=>value.children.includes(label));expect(button).toBeTruthy();await act(async()=>{button.props.onClick();});}
function formData(values:Record<string,string>){vi.stubGlobal('FormData',class{get(name:string){return values[name]??null;}});}
async function submit(){await act(async()=>{tree.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}});});}
it.each([undefined,'TOKEN'])('submits the actual write-only %s form, excluding the password from FormData',async(name)=>{
 const field={value:'synthetic-private'},copied:string[]=[];transport(()=>expect(field.value).toBe(''));
 await draw(ValueControl,{name,description:'Description'},field);
 const inputs=tree.root.findAllByType('input');expect(inputs.find((input:any)=>input.props.type==='password').props.name).toBeUndefined();
 vi.stubGlobal('FormData',class{constructor(){for(const input of inputs)if(input.props.name)copied.push(input.props.name);}get(key:string){return key==='name'?'TOKEN':key==='description'?'Description':null;}});
 await submit();expect(copied).not.toContain('value');expect(payloads).toEqual([{url:'/api/secrets/set',input:{id:expect.stringMatching(/^[0-9a-f-]{36}$/),name:'TOKEN',description:'Description',mode:name?'replace':'add',value:'synthetic-private'}}]);
 expect(field.value).toBe('');
});
it('clears the actual password field before removing a value',async()=>{
 const field={value:'unsaved-synthetic'};transport(()=>expect(field.value).toBe(''));await draw(ValueControl,{name:'TOKEN'},field);
 await click('Remove value and revoke access');expect(payloads).toEqual([{url:'/api/secrets/remove',input:{id:expect.any(String),name:'TOKEN'}}]);
});
it('submits allow, deny, always and cancel from the actual request controls',async()=>{
 transport();await draw(RequestControl,{id:'request'});
 await act(async()=>tree.root.findByType('input').props.onChange({target:{checked:true}}));
 await click('Allow');await click('Deny');await click('Cancel request');
 expect(payloads).toEqual([{url:'/api/secrets/command',input:{action:'answer',id:'request',allow:true,always:true}},{url:'/api/secrets/command',input:{action:'answer',id:'request',allow:false,always:true}},{url:'/api/secrets/command',input:{action:'cancel',id:'request'}}]);
});
it('submits revoke, default and both rule timings from their actual controls',async()=>{
 transport();await draw(RevokeControl,{id:'grant'});await click('Revoke grant');await act(async()=>tree.unmount());
 await draw(DefaultControl,{answer:'ask'});formData({answer:'never'});await submit();expect(requestedInput()).toEqual({answer:'never'});await act(async()=>tree.unmount());
 await draw(RuleControl,{secret:'TOKEN',snapshot:{rules:[],ruleAgents:[]}});formData({answer:'auto',minutes:'10',on_request:'art, mark',at_start:'art'});await submit();
 expect(payloads).toEqual([{url:'/api/secrets/command',input:{action:'revoke',id:'grant'}}]);
 expect(requestedInput()).toEqual({secret:'TOKEN',answer:'auto',minutes:10,agents:[{agent:'art',when:'on_request'},{agent:'mark',when:'on_request'},{agent:'art',when:'at_start'}]});
});
it('keeps the password uncontrolled and absent from rendered state through submission and rerender',async()=>{
 const field={value:'synthetic-render-secret'};transport();await draw(ValueControl,{name:'TOKEN'},field);
 const password=()=>tree.root.findAllByType('input').find((input:any)=>input.props.type==='password');
 expect(password().props.value).toBeUndefined();expect(password().props.defaultValue).toBeUndefined();
 expect(password().props.onChange).toBeUndefined();expect(JSON.stringify(tree.toJSON(),(key,value)=>key==='ref'?undefined:value)).not.toContain(field.value);
 formData({description:'Description'});await submit();expect(field.value).toBe('');
 await act(async()=>tree.update(h(ValueControl,{name:'TOKEN',description:'Updated metadata'})));
 expect(password().props.value).toBeUndefined();expect(password().props.defaultValue).toBeUndefined();
 expect(JSON.stringify(tree.toJSON(),(key,value)=>key==='ref'?undefined:value)).not.toContain('synthetic-render-secret');expect(field.value).toBe('');
});

it('keeps a removal field empty after a transport failure without replay or upstream diagnostics',async()=>{
 const field={value:'synthetic-unsaved'},request=vi.fn(async()=>{expect(field.value).toBe('');throw Error('synthetic-upstream-credential');});vi.stubGlobal('fetch',request);
 await draw(ValueControl,{name:'TOKEN'},field);await click('Remove value and revoke access');
 expect(field.value).toBe('');expect(request).toHaveBeenCalledOnce();
 expect(JSON.stringify(tree.toJSON(),(key,value)=>key==='ref'?undefined:value)).not.toContain('synthetic-upstream-credential');
});
