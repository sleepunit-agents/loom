import {expect,it,vi} from 'vitest';
import {createElement as h} from '../../../node_modules/react/index.js';
import {act,create} from '../../../node_modules/react-test-renderer/index.js';
import Usage from './index';

const feed=vi.hoisted(()=>vi.fn());
vi.mock('../../data/graphql',()=>({useDataQuery:feed}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it('orders conversations by reported tokens and opens the selected jobs in the same range',async()=>{
  feed.mockImplementation((query:string)=>({status:'live',data:query.includes('conversationJobUsage')?
    {conversationJobUsage:[{id:'j-one',observations:['Large context with no tool calls.'],usage:{source:'report',model:'test-model',toolCalls:0,tools:[],tokensIn:null}}]}:
    {jobUsageRollup:[{key:'small',title:'Small',totalTokens:1,jobCount:1,retryCount:0},{key:'large',title:'Large',totalTokens:999,jobCount:1,retryCount:0}]}}));
  let tree!:ReturnType<typeof create>;
  await act(async()=>{tree=create(h(Usage));});
  try {
    const buttons=tree.root.findAllByType('button');
    expect(buttons.map(b=>b.props.children)).toEqual(['Large','Small']);
    await act(async()=>buttons[0].props.onClick());
    expect(JSON.stringify(tree.toJSON())).toContain('Large context with no tool calls.');
    expect(JSON.stringify(tree.toJSON())).toContain('Unknown');
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
