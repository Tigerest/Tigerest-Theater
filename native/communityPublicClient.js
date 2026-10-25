(function(){
    'use strict';
    class PublicClient extends window.TigerestCommunityClient {
        constructor(session,avatars){super();this.session=session;this.avatars=avatars;this.public=true;}
        prepareSend(attempt){return this.avatars?.prepare(attempt);}
        afterSend(result,attempt){this.avatars?.sent(result,attempt);}
        setSession(emby){return this.setContext(emby);}
        setContext(emby,itemId=null){
            this.session.setSession(emby);
            const key=JSON.stringify([this.session.fingerprint,itemId]);
            if(key!==this.contextKey){this.clear();this.contextKey=key;this.context={itemId};}
            return !!emby?.token;
        }
        setMedia(item,series=null){this.media={item,series};}
        static async locateMedia(api,media){
            if(!api?.getItems||!['movie','tv'].includes(media?.mediaType)||!/^[1-9][0-9]{0,17}$/.test(media?.tmdbId||''))return null;
            const type=media.mediaType==='movie'?'Movie':'Series',userId=api.getCurrentUserId();
            const fields=window.TigerestServer?.fields?.('ProviderIds,DisplayOrder')??'ProviderIds,DisplayOrder';
            const own=i=>i.Type===type&&String(i.ProviderIds?.Tmdb||i.ProviderIds?.tmdb)===media.tmdbId;
            let matches=[];
            if(window.TigerestServer?.isJellyfin?.()){
                // Jellyfin has no provider ID filter; read the IDs of every work that has a TMDB ID.
                for(let start=0;;start+=500){
                    if(start>=20000)return null;
                    const page=await api.getItems(userId,{Recursive:true,IncludeItemTypes:type,HasTmdbId:true,Fields:fields,StartIndex:start,Limit:500,EnableImages:false,EnableUserData:false});
                    matches.push(...(page.Items||[]).filter(own));
                    if((page.Items?.length||0)<500)break;
                }
            }else{
                const result=await api.getItems(userId,{Recursive:true,IncludeItemTypes:type,AnyProviderIdEquals:'tmdb.'+media.tmdbId,Fields:fields,Limit:100});
                if((result.TotalRecordCount||0)>(result.Items?.length||0))return null;
                matches=(result.Items||[]).filter(own);
            }
            if(matches.length!==1)return null;
            if(media.scope==='work')return matches[0];
            if(media.scope!=='episode'||type!=='Series')return null;
            const episodes=await api.getItems(userId,{ParentId:matches[0].Id,Recursive:true,IncludeItemTypes:'Episode',Fields:fields,Limit:10000});
            if((episodes.TotalRecordCount||0)>(episodes.Items?.length||0))return null;
            const exact=(episodes.Items||[]).filter(i=>{
                try{const identity=PublicClient.mediaIdentity(i,matches[0],'episode');return identity.season===media.season&&identity.episode===media.episode;}catch(_){return false;}
            });
            return exact.length===1?exact[0]:null;
        }
        static mediaIdentity(item,series,scope){
            const work=item?.Type==='Movie'||item?.Type==='Series'?item:series;
            const tmdbId=String(work?.ProviderIds?.Tmdb||work?.ProviderIds?.tmdb||'');
            if(!/^[1-9][0-9]{0,17}$/.test(tmdbId))throw new Error('缺少可靠的剧集或影片 TMDB 信息，暂不支持公共评论。');
            const mediaType=item.Type==='Movie'?'movie':'tv',body={mediaType,tmdbId,scope};
            if(scope==='episode'){
                const order=item.DisplayOrder||series?.DisplayOrder;
                if(item.Type!=='Episode'||!['aired','Aired'].includes(order)||item.IndexNumberEnd!=null&&item.IndexNumberEnd!==item.IndexNumber||
                    !Number.isInteger(item.ParentIndexNumber)||item.ParentIndexNumber<0||item.ParentIndexNumber>1000||!Number.isInteger(item.IndexNumber)||item.IndexNumber<1||item.IndexNumber>10000)
                    throw new Error('此媒体的集序不明确，暂不支持公共单集评论。');
                Object.assign(body,{season:item.ParentIndexNumber,episode:item.IndexNumber,order:'aired'});
            }else if(scope!=='work')throw new Error('评论范围无效。');
            return body;
        }
        resolve(scope){return this.request('/topics/resolve',{method:'POST',body:PublicClient.mediaIdentity(this.media?.item,this.media?.series,scope)});}
        async request(path,options={}){
            const generation=this.generation,controller=new AbortController();this.controllers.add(controller);
            const cancel=()=>controller.abort();options.signal?.addEventListener('abort',cancel,{once:true});if(options.signal?.aborted)cancel();
            try{
                const data=await this.session.request(path,{...options,signal:controller.signal});
                if(generation!==this.generation)throw Object.assign(new Error('请求已取消'),{name:'AbortError'});
                return data;
            }catch(error){if(error.status===429&&options.method==='POST')this.cooldownUntil=Math.max(this.cooldownUntil,this.now()+error.retryAfter*1000);throw error;}
            finally{options.signal?.removeEventListener('abort',cancel);this.controllers.delete(controller);}
        }
        // A retry of the same report keeps its UUID; the caller owns that identity.
        flag(commentId,reason,note,clientRequestId){
            return this.request('/comments/'+encodeURIComponent(commentId)+'/flags',{method:'POST',body:{reason,...(note?{note}:{}),clientRequestId}});
        }
        block(authorId){return this.request('/me/blocks/'+encodeURIComponent(authorId),{method:'PUT'});}
        unblock(authorId){return this.request('/me/blocks/'+encodeURIComponent(authorId),{method:'DELETE'});}
        blocks(cursor){return this.page('/me/blocks',cursor,false);}
        messageSummary(){return this.request('/me/messages?limit=1');}
        messages(kind='replies',cursor,unreadOnly=false){
            if(!['sent','replies'].includes(kind))return Promise.reject(new Error('消息类型无效。'));
            return this.page(kind==='sent'?'/me/comments':'/me/messages?unreadOnly='+!!unreadOnly,cursor,false);
        }
        avatar(path,options={}){
            if(!/^\/community\/v2\/avatars\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\?v=[0-9a-f]{64}$/i.test(path||''))return Promise.reject(new Error('头像暂不可用'));
            return this.request(path.slice('/community/v2'.length),{...options,responseType:'image'});
        }
    }
    window.TigerestCommunityPublicClient=PublicClient;
})();
