#pragma once

#include "FrameInterpolationController.h"
#include <QHash>

namespace rife {
// mpv's macvk VO waits for the Cocoa main queue while it is destroyed. A
// synchronous property request from that queue can therefore deadlock even
// before END_FILE reaches the client. Timer work reads observed values and
// queues its writes instead.
class MpvPollAccess {
public:
    explicit MpvPollAccess(MpvAccess access):base(std::move(access)){}

    class Scope {
    public:
        explicit Scope(MpvPollAccess& owner):access(owner),previous(owner.polling){access.polling=true;}
        ~Scope(){access.polling=previous;}
        Scope(const Scope&)=delete;
        Scope& operator=(const Scope&)=delete;
    private:
        MpvPollAccess& access;
        bool previous;
    };

    Scope enterPolling(){return Scope(*this);}
    void observe(const QString& key,const QVariant& value){observed.insert(key,value);}
    void clearMedia(){
        for(const auto& key:{"video-params","video-frame-info","container-fps",
                             "seeking","paused-for-cache","frame-drop-count",
                             "decoder-frame-drop-count","playback-time","duration",
                             "avsync","display-fps","mistimed-frame-count",
                             "video-out-params","current-vo","hwdec-current"})
            observed.remove(QString::fromLatin1(key));
    }
    void completeTaggedSet(int id,int error){
        const auto found=taggedWrites.find(id);
        if(found==taggedWrites.end())return;
        if(error>=0)observed.insert(found->first,found->second);
        taggedWrites.erase(found);
    }
    bool has(const QString& key)const{return observed.contains(key);}
    QVariant value(const QString& key)const{return observed.value(key);}

    MpvAccess interface(){MpvAccess result{
        [this](const QString& key){return polling?observed.value(key):base.read(key);},
        [this](const QString& key,const QVariant& value){
            const bool accepted=polling?base.setAsync(key,value):base.set(key,value);
            if(accepted)observed.insert(key,value);
            return accepted;
        },
        [this](const QStringList& args){
            const bool accepted=polling?base.commandAsync(args):base.command(args);
            if(accepted)updateFilterCache(args);
            return accepted;
        },
        [this](const QString& key,const QVariant& value){
            const bool accepted=base.setAsync(key,value);
            if(accepted)observed.insert(key,value);
            return accepted;
        },
        [this](const QStringList& args){
            const bool accepted=base.commandAsync(args);
            if(accepted)updateFilterCache(args);
            return accepted;
        },
        [this](const QString& key,const QVariant& value,int id){
            const bool accepted=base.setAsyncTagged?base.setAsyncTagged(key,value,id):base.setAsync(key,value);
            if(accepted){
                if(base.setAsyncTagged)taggedWrites.insert(id,{key,value});
                else observed.insert(key,value);
            }
            return accepted;
        }
    };
        // Preserve the startup writer's legacy fallback, but advertise actual
        // completion events separately for the clock transaction protocol.
        result.asyncPropertyReplies=base.asyncPropertyReplies;
        if(base.getAsyncTagged)result.getAsyncTagged=base.getAsyncTagged;
        return result;
    }

private:
    void updateFilterCache(const QStringList& args){
        if(args.size()<3||args[0]!="vf")return;
        const auto label=QStringLiteral("tigerest-rife");
        auto filters=observed.value(QStringLiteral("vf")).toList();
        if(args[1]=="add"&&args[2].startsWith("@tigerest-rife:"))
            filters.append(QVariantMap{{"name","vapoursynth"},{"label",label}});
        else if(args[1]=="remove"&&args[2]=="@tigerest-rife"){
            for(qsizetype i=filters.size();i>0;--i)
                if(filters[i-1].toMap().value("label")==label)filters.removeAt(i-1);
        }else return;
        observed.insert(QStringLiteral("vf"),filters);
    }
    MpvAccess base;
    QHash<QString,QVariant> observed;
    QHash<int,QPair<QString,QVariant>> taggedWrites;
    bool polling=false;
};
}
