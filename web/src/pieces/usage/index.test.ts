import {expect,it,vi} from 'vitest';
import {createElement as h} from '../../../node_modules/react/index.js';
import {act,create} from '../../../node_modules/react-test-renderer/index.js';
import Usage from './index';

const feed=vi.hoisted(()=>vi.fn());
vi.mock('../../data/graphql',()=>({useDataQuery:feed}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it('orders conversations by reported tokens and opens the selected jobs in the same range',async()=>{
  feed.mockImplementation((query:string)=>({status:'live',data:query.includes('conversationJobUsage')?
    {conversationJobUsage:[{id:'j-one',title:'Inspect parser',runKind:'subagent',observations:['Large context with no tool calls.'],usage:{source:'report',model:'test-model',toolCalls:0,tools:[],tokensIn:null}}]}:
    {jobUsageRollup:[{key:'small',title:'Small',totalTokens:1,jobCount:1,retryCount:0,largestContext:null,jobsWithLargestContext:0},{key:'large',title:'Large',totalTokens:999,jobCount:2,retryCount:0,largestContext:812,jobsWithLargestContext:1}]}}));
  let tree!:ReturnType<typeof create>;
  await act(async()=>{tree=create(h(Usage));});
  try {
    const buttons=tree.root.findAllByType('button');
    expect(tree.root.findAllByType('small').map(node=>node.children.join(''))).toEqual(['1 of 2 measured','0 of 1 measured']);
    expect(buttons.map(b=>b.props.children)).toEqual(['Large','Small']);
    await act(async()=>buttons[0].props.onClick());
    const job=tree.root.findByProps({'data-split-row':''});
    expect(job.props['aria-expanded']).toBe(false);
    expect(JSON.stringify(tree.toJSON())).not.toContain('Large context with no tool calls.');
    await act(async()=>job.props.onClick());
    expect(job.props['aria-expanded']).toBe(true);
    expect(JSON.stringify(tree.toJSON())).toContain('Large context with no tool calls.');
    expect(JSON.stringify(tree.toJSON())).toContain('Unknown');
    expect(JSON.stringify(tree.toJSON())).toContain('Inspect parser');
    expect(JSON.stringify(tree.toJSON())).toContain('Subagent');
    await act(async()=>job.props.onClick());
    expect(job.props['aria-expanded']).toBe(false);
    expect(tree.root.findAllByType('button')[0].props['aria-expanded']).toBe(true);
    const vars=feed.mock.calls.find(([q])=>q.includes('conversationJobUsage'))![1];
    expect(vars).toMatchObject({...feed.mock.calls[0][1],conversation:'large'});
    await act(async()=>tree.root.findAllByType('input')[0].props.onChange({target:{value:''}}));
    expect(JSON.stringify(tree.toJSON())).not.toContain('test-model');
  } finally { await act(async()=>tree.unmount()); }
});

it('uses selections and argument types served by the runtime',async()=>{
  const {parse,validate,GraphQLSchema,GraphQLObjectType}=await import('../../../../node_modules/graphql/index.js');
  const {jobSummaryFields}=await import('../../../../src/runtime/job-summary');
  const {conversationsQuery,jobsQuery}=await import('./index');
  const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:jobSummaryFields({} as never)})});
  for(const selection of [conversationsQuery,jobsQuery])expect(validate(schema,parse(selection))).toEqual([]);
});

it('keeps the table and the opened conversation on screen while another date range loads',async()=>{
  const day=(n:number)=>`2026-11-${String(n).padStart(2,'0')}`;
  // The page starts on the six days up to today, so the days chosen below are only a valid range on a known day.
  vi.useFakeTimers({now:new Date(day(20)+'T12:00:00'),toFake:['Date']});
  let changing=false;
  // As the data hook answers: with `keep`, the last answer again, marked settling; without it, loading.
  feed.mockImplementation((query:string,_variables:unknown,options?:{keep?:boolean})=>changing&&!options?.keep?{status:'loading'}:{status:'live',settling:changing||undefined,data:query.includes('conversationJobUsage')?
    {conversationJobUsage:[{id:'j-one',title:'Inspect parser',runKind:'main',observations:[],usage:null}]}:
    {jobUsageRollup:[{key:'large',title:'Large',totalTokens:999,jobCount:2,retryCount:0,largestContext:812,jobsWithLargestContext:1}]}});
  let tree!:ReturnType<typeof create>;
  await act(async()=>{tree=create(h(Usage));});
  try {
    await act(async()=>tree.root.findAllByType('button')[0].props.onClick());
    const [first,last]=tree.root.findAllByType('input');
    await act(async()=>last.props.onChange({target:{value:day(20)}}));
    changing=true;
    await act(async()=>first.props.onChange({target:{value:day(1)}}));
    const text=JSON.stringify(tree.toJSON());
    expect(text).toContain('Large');expect(text).toContain('Inspect parser');expect(text).not.toContain('Loading');
    expect(tree.root.findAll(node=>(node.type==='table'||node.type==='section')&&node.props['aria-busy']).map(node=>node.props['aria-busy'])).toEqual([true,true]);
    expect(tree.root.findAllByType('button')[0].props['aria-expanded']).toBe(true);
    expect(feed.mock.calls.at(-1)![1]).toMatchObject({from:new Date(day(1)+'T00:00:00').toISOString(),conversation:'large'});
  } finally { await act(async()=>tree.unmount()); vi.useRealTimers(); }
});
