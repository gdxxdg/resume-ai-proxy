'use strict';
/* 后端代理服务 · 结构适配层单元测试 */

const P = require('./server.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

console.log('=== 1. normalize 完整结构 ===');
const full = P.normalize({
  personal: {
    name: ' 李思远 ', phone: '13812345678', email: 'a@b.com', gender: '男',
    age: 23, nation: '汉', hometown: '湖南长沙', political: '共青团员', gradYear: '2026'
  },
  intention: { position: '前端开发工程师', city: '深圳' },
  edu: [{ title: '湖南大学', sub: '软件工程 · 本科', date: '2022年9月-2026年6月', notes: ['GPA 3.7', '专业排名前 10%'] }],
  work: [{ company: '腾讯', position: '前端开发实习生', period: '2025.07至2025.09', details: '负责数据看板开发，页面加载速度提升 35%' }],
  project: [{ name: '校园二手交易平台', role: '后端负责人', tech: 'Spring Boot', highlights: ['日活 2000+'] }],
  skills: '熟悉 Java、Python',
  awards: ['校级一等奖学金', 'CET-6'],
  unmatched: []
});
ok('name 去空格', full.personal.name === '李思远', full.personal.name);
ok('age 转字符串', full.personal.age === '23', full.personal.age);
ok('gradYear 转数字', full.personal.gradYear === 2026, full.personal.gradYear);
ok('hometown 保留', full.personal.hometown === '湖南长沙', full.personal.hometown);
ok('edu 日期归一化', full.edu[0].date === '2022.09 - 2026.06', full.edu[0].date);
ok('edu notes 两条', full.edu[0].notes.length === 2, full.edu[0].notes);
ok('work 别名 company->title', full.work[0].title === '腾讯', full.work[0].title);
ok('work 别名 position->sub', full.work[0].sub === '前端开发实习生', full.work[0].sub);
ok('work 日期 "至" 归一化', full.work[0].date === '2025.07 - 2025.09', full.work[0].date);
ok('work details 字符串->数组', full.work[0].notes.length === 1, full.work[0].notes);
ok('project 别名 name->title', full.project[0].title === '校园二手交易平台', full.project[0].title);
ok('project 别名 role->sub', full.project[0].sub === '后端负责人', full.project[0].sub);
ok('skills 字符串->数组', Array.isArray(full.skills) && full.skills.length === 1, full.skills);
ok('awards 保留两条', full.awards.length === 2, full.awards);

console.log('\n=== 2. normalize 异常输入容错 ===');
const t1 = P.normalize(null);
ok('null 输入不抛错', t1.personal.name === '' && t1.edu.length === 0);
const t2 = P.normalize({ edu: '不是数组', skills: null, awards: {} });
ok('edu 字符串->单元素', t2.edu.length === 1 && t2.edu[0].title === '不是数组', t2.edu);
ok('skills null -> []', Array.isArray(t2.skills) && t2.skills.length === 0);
ok('awards 空对象 -> []', Array.isArray(t2.awards) && t2.awards.length === 0, t2.awards);
const t3 = P.normalize({ edu: [null, 123, {}, { title: '有标题' }] });
ok('edu 过滤无效项', t3.edu.length === 1 && t3.edu[0].title === '有标题', t3.edu);
const t4 = P.normalize({ personal: { gradYear: 'abc' } });
ok('gradYear 非法 -> null', t4.personal.gradYear === null, t4.personal.gradYear);
const t5 = P.normalize({ edu: [{ title: 'X', sub: 'X' }] });
ok('title===sub 时 sub 置空', t5.edu[0].sub === '', t5.edu[0]);

console.log('\n=== 3. 日期归一化 ===');
ok('2022.09 - 2026.06 保持', P.normDate('2022.09 - 2026.06') === '2022.09 - 2026.06', P.normDate('2022.09 - 2026.06'));
ok('2022/9~2026/6', P.normDate('2022/9~2026/6') === '2022.09 - 2026.06', P.normDate('2022/9~2026/6'));
ok('中文月份', P.normDate('2022年九月-2026年六月') === '2022.09 - 2026.06', P.normDate('2022年九月-2026年六月'));
ok('至今', P.normDate('2025.07-至今') === '2025.07 - 至今', P.normDate('2025.07-至今'));
ok('单独年份', P.normDate('2026') === '2026', P.normDate('2026'));
ok('空串', P.normDate('') === '', P.normDate(''));
ok('破折号', P.normDate('2022年9月—2026年6月') === '2022.09 - 2026.06', P.normDate('2022年9月—2026年6月'));

console.log('\n=== 4. extractJSON 健壮性 ===');
ok('纯 JSON', JSON.stringify(P.extractJSON('{"a":1}')) === '{"a":1}');
ok('markdown 围栏', JSON.stringify(P.extractJSON('```json\n{"a":1}\n```')) === '{"a":1}');
ok('无语言标记围栏', JSON.stringify(P.extractJSON('```\n{"a":1}\n```')) === '{"a":1}');
ok('前后有解释文字', JSON.stringify(P.extractJSON('好的，结果如下：{"a":1} 希望有帮助')) === '{"a":1}');
ok('空内容 -> null', P.extractJSON('') === null);
ok('非 JSON -> null', P.extractJSON('抱歉我无法处理') === null);
ok('嵌套花括号', JSON.stringify(P.extractJSON('前缀 {"a":{"b":[1,2]}} 后缀')) === '{"a":{"b":[1,2]}}');

console.log('\n=== 5. SYSTEM_PROMPT 合规性 ===');
ok('含 json 字样（JSON mode 硬要求）', /json/i.test(P.SYSTEM_PROMPT));
ok('含 SCHEMA 字段名', /"personal"/.test(P.SYSTEM_PROMPT) && /"hometown"/.test(P.SYSTEM_PROMPT));
ok('含籍贯判定规则', /山东济南/.test(P.SYSTEM_PROMPT));
ok('要求第三人称文体', /第三人称/.test(P.SYSTEM_PROMPT));
ok('禁止第一人称代词', /第一人称/.test(P.SYSTEM_PROMPT) && /「我」/.test(P.SYSTEM_PROMPT));
ok('保留量化数据与不臆造的底线', /不新增原文没有的信息/.test(P.SYSTEM_PROMPT) && /不丢掉量化数据/.test(P.SYSTEM_PROMPT));
ok('给了口语改写示例', /我用得很熟/.test(P.SYSTEM_PROMPT) && /熟练使用/.test(P.SYSTEM_PROMPT));
ok('skills 字段要求不带主语', /不带主语/.test(P.SYSTEM_PROMPT));
ok('unmatched 仍保留原文（例外已声明）', /unmatched/.test(P.SYSTEM_PROMPT));

console.log('\n=== 6. 默认模型随上游自适应 ===');
ok('官方 API 判定为真', P.isOfficialApi('https://api.deepseek.com/chat/completions') === true);
ok('纯域名判定为真', P.isOfficialApi('https://api.deepseek.com') === true);
ok('自建网关判定为假', P.isOfficialApi('https://xxx.agentos-app.run/v1/chat/completions') === false);
ok('伪装域名判定为假', P.isOfficialApi('https://api.deepseek.com.evil.com/v1') === false);
ok('白名单含官方现役模型', P.MODELS.indexOf('deepseek-v4-flash') > -1 && P.MODELS.indexOf('deepseek-v4-pro') > -1, P.MODELS);
ok('默认模型必在白名单内（否则默认配置必然报错）', P.MODELS.indexOf(P.DEFAULT_MODEL) > -1, P.DEFAULT_MODEL);

console.log('\n=== 7. 端到端：模拟模型返回 ===');
const fakeModelOutput = {
  choices: [{
    message: {
      content: '```json\n' + JSON.stringify({
        personal: { name: '小明', hometown: '山东济南', gender: '男' },
        awards: ['三好学生'],
        skills: '熟悉 Java',
        edu: [{ school: '山东大学', major: '计算机', date: '2022年9月-2026年6月' }]
      }) + '\n```'
    }
  }],
  usage: { total_tokens: 500 }
};
const parsedRaw = P.extractJSON(fakeModelOutput.choices[0].message.content);
const final = P.normalize(parsedRaw);
ok('姓名抽取', final.personal.name === '小明', final.personal.name);
ok('籍贯抽取', final.personal.hometown === '山东济南', final.personal.hometown);
ok('奖项未被个人信息污染', final.awards.length === 1 && final.awards[0] === '三好学生', final.awards);
ok('技能字符串转数组', final.skills.length === 1, final.skills);
ok('教育 school 别名', final.edu[0].title === '山东大学', final.edu[0].title);
ok('教育日期归一化', final.edu[0].date === '2022.09 - 2026.06', final.edu[0].date);

console.log('\n' + pass + '/' + (pass + fail) + ' 通过');
if (fail) { console.log(fail + ' 项失败'); process.exit(1); }
